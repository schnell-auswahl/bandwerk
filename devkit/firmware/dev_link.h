// Non-blocking USB serial link between a Daisy/Hothouse and the host
// (development builds). Header-only.
//
//   devkit::DevLink link;  link.Init();           // once, after hw.Init()
//   link.Print("[X] %d\r\n", value);              // never blocks, drops when busy
//   if (link.CanPrint() && link.PopLine(buf, n))  // one received text line
//
// Why not daisy::Logger / hw.seed.PrintLine: after two packets it switches to
// blocking transfers for good. When the terminal is closed afterwards, the
// next PrintLine never returns and the whole main loop freezes until someone
// reads the port again. DevLink only ever tries to hand a message to the USB
// driver and drops it when the driver is busy.
//
// Transmit: two buffers alternate. A transfer that has been accepted keeps
// using its buffer until the driver accepts the next one, so a new message is
// always formatted into the other buffer.
// Receive: the USB interrupt only copies bytes into a ring buffer, lines are
// assembled in the main loop (PopLine).
#pragma once

#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <cstdio>

#include "daisy_seed.h"

namespace devkit {

class DevLink {
 public:
  static constexpr size_t kTxSize = 448;
  static constexpr size_t kRxSize = 256;
  static constexpr size_t kLineSize = 96;

  // Brings up the USB CDC port and starts receiving.
  void Init() {
    daisy::DaisySeed::StartLog(false);  // starts the USB CDC port, no waiting
    usb_.SetReceiveCallback(&DevLink::OnReceive, daisy::UsbHandle::FS_INTERNAL);
  }

  // Formats one message (may contain several lines, use "\r\n"). Returns
  // false and drops the message while the previous one is still waiting.
  bool Print(const char* fmt, ...) {
    Pump();
    if (pending_) return false;
    va_list va;
    va_start(va, fmt);
    const int n = vsnprintf(buf_[cur_], kTxSize, fmt, va);
    va_end(va);
    if (n <= 0) return true;
    len_ = static_cast<size_t>(n) < kTxSize ? static_cast<size_t>(n) : kTxSize - 1;
    pending_ = true;
    Pump();
    return true;
  }

  // True when a new message would be accepted right now.
  bool CanPrint() {
    Pump();
    return !pending_;
  }

  // Hands a waiting message to the driver if it is free.
  void Pump() {
    if (!pending_) return;
    if (usb_.TransmitInternal(reinterpret_cast<uint8_t*>(buf_[cur_]), len_) ==
        daisy::UsbHandle::Result::OK) {
      cur_ ^= 1;
      pending_ = false;
    }
  }

  // Copies the next complete received line (without line ending) into `out`.
  // Returns false when no complete line has arrived yet.
  bool PopLine(char* out, size_t cap) {
    Ring& r = ring();
    while (r.tail != r.head) {
      const char c = static_cast<char>(r.data[r.tail]);
      r.tail = (r.tail + 1) % kRxSize;
      if (c == '\n') {
        if (line_len_ == 0) continue;  // empty line
        line_[line_len_] = '\0';
        const size_t n = line_len_ < cap - 1 ? line_len_ : cap - 1;
        for (size_t i = 0; i < n; ++i) out[i] = line_[i];
        out[n] = '\0';
        line_len_ = 0;
        return true;
      }
      if (c == '\r') continue;
      if (line_len_ < kLineSize - 1) line_[line_len_++] = c;  // longer lines are cut
    }
    return false;
  }

 private:
  struct Ring {
    volatile uint8_t data[kRxSize];
    volatile uint32_t head = 0;  // written by the USB interrupt
    volatile uint32_t tail = 0;  // written by the main loop
  };
  static Ring& ring() {
    static Ring r;
    return r;
  }
  static void OnReceive(uint8_t* buf, uint32_t* len) {
    Ring& r = ring();
    for (uint32_t i = 0; i < *len; ++i) {
      const uint32_t next = (r.head + 1) % kRxSize;
      if (next == r.tail) break;  // full: drop the rest
      r.data[r.head] = buf[i];
      r.head = next;
    }
  }

  daisy::UsbHandle usb_;  // stateless: shares the port set up by StartLog()
  char buf_[2][kTxSize];
  size_t len_ = 0;
  int cur_ = 0;
  bool pending_ = false;
  char line_[kLineSize];
  size_t line_len_ = 0;
};

}  // namespace devkit
