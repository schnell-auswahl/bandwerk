// Hardware-free core of devkit::DevLink (dev_link.h): the transmit queue and
// the receive line assembler. Kept apart from the USB driver so that the
// "never blocks" guarantees can be unit-tested on the host.
//
//   TxQueue<Transport, N>  formats messages into two alternating buffers and
//                          hands them to Transport::Transmit(), which must
//                          return immediately (true = accepted). Nothing in
//                          here ever waits, except Flush(), which waits at
//                          most the given number of milliseconds.
//   LineReceiver<N, L>     single-producer / single-consumer byte ring (the
//                          USB interrupt pushes, the main loop pops) plus the
//                          line assembly. A partial line that receives no
//                          further bytes for kStaleMs is discarded, so a host
//                          that vanished in the middle of a line cannot glue
//                          its fragment to the next host's first command.
//
// Transport interface:
//   bool Transmit(const uint8_t* data, size_t len);  // never blocks
//   void DelayMs(uint32_t ms);                       // only used by Flush()
#pragma once

#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <cstdio>

namespace devkit {

template <class Transport, size_t kTxSize>
class TxQueue {
 public:
  explicit TxQueue(Transport& transport) : transport_(transport) {}

  // Formats one message (may contain several lines). Returns false and drops
  // the message while the previous one is still waiting for the driver.
  bool Print(const char* fmt, ...) {
    va_list va;
    va_start(va, fmt);
    const bool ok = VPrint(fmt, va);
    va_end(va);
    return ok;
  }

  bool VPrint(const char* fmt, va_list va) {
    Pump();
    if (pending_) return false;
    const int n = vsnprintf(buf_[cur_], kTxSize, fmt, va);
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

  // Hands a waiting message to the driver if it is free. One attempt, no waiting.
  void Pump() {
    if (!pending_) return;
    if (transport_.Transmit(reinterpret_cast<const uint8_t*>(buf_[cur_]), len_)) {
      cur_ ^= 1;  // the driver owns that buffer now; format the next message into the other one
      pending_ = false;
    }
  }

  // Keeps trying to hand the waiting message to the driver for at most
  // max_ms milliseconds (used before a reset, so a reply is not lost).
  // Returns true when nothing is waiting any more.
  bool Flush(uint32_t max_ms) {
    for (uint32_t i = 0; pending_ && i < max_ms; ++i) {
      Pump();
      if (pending_) transport_.DelayMs(1);
    }
    Pump();
    return !pending_;
  }

  bool pending() const { return pending_; }

 private:
  Transport& transport_;
  char buf_[2][kTxSize];
  size_t len_ = 0;
  int cur_ = 0;
  bool pending_ = false;
};

template <size_t kRxSize, size_t kLineSize>
class LineReceiver {
 public:
  // A partial line is dropped when no byte arrived for this long.
  static constexpr uint32_t kStaleMs = 1000;

  // constexpr: a static instance is constant-initialized (no guard variable,
  // safe to use first from the interrupt).
  constexpr LineReceiver() = default;

  // Interrupt side: copies received bytes into the ring; drops what does not fit.
  void Push(const uint8_t* buf, uint32_t len) {
    for (uint32_t i = 0; i < len; ++i) {
      const uint32_t next = (head_ + 1) % kRxSize;
      if (next == tail_) break;  // full: drop the rest
      data_[head_] = buf[i];
      head_ = next;
    }
  }

  // Main loop side: copies the next complete line (without line ending,
  // '\r' ignored, cut at kLineSize - 1 characters) into `out`. Returns false
  // when no complete line has arrived yet.
  bool PopLine(char* out, size_t cap, uint32_t now_ms) {
    // The sender went away in the middle of a line: whatever arrives now
    // belongs to a new line. (Checked before new bytes are taken.)
    if (line_len_ > 0 && now_ms - last_byte_ms_ > kStaleMs) line_len_ = 0;
    while (tail_ != head_) {
      const char c = static_cast<char>(data_[tail_]);
      tail_ = (tail_ + 1) % kRxSize;
      last_byte_ms_ = now_ms;
      if (c == '\n') {
        if (line_len_ == 0) continue;  // empty line
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

  size_t partial_length() const { return line_len_; }

 private:
  volatile uint8_t data_[kRxSize] = {};
  volatile uint32_t head_ = 0;  // written by the interrupt
  volatile uint32_t tail_ = 0;  // written by the main loop
  char line_[kLineSize] = {};
  size_t line_len_ = 0;
  uint32_t last_byte_ms_ = 0;
};

}  // namespace devkit
