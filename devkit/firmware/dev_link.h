// Non-blocking USB serial link between a Daisy/Hothouse and the host.
// Header-only. Safe to ship in release firmware: nothing here waits for the
// host (see the guarantees below).
//
//   devkit::DevLink link;  link.Init();           // once, after hw.Init()
//   link.Print("[X] %d\r\n", value);              // never blocks, drops when busy
//   if (link.CanPrint() && link.PopLine(buf, n))  // one received text line
//
// Why not daisy::Logger / hw.seed.PrintLine: after two packets it switches to
// blocking transfers for good. When the terminal is closed afterwards, the
// next PrintLine never returns and the whole main loop freezes until someone
// reads the port again. DevLink does not use the Logger at all (not even
// StartLog); it only ever offers a message to the USB driver and drops it
// when the driver is busy.
//
// Guarantees (the logic lives in dev_link_core.h and is unit-tested on the host):
// - Print(), CanPrint(), Pump() and PopLine() return immediately in every USB
//   state: no cable, USB power without a host, enumerated but port closed,
//   port closed in the middle of a transfer, cable pulled. Only Flush() waits,
//   and at most for the given time.
// - A message is only offered to the driver while the device is configured by
//   a host; otherwise it waits in its buffer (later messages are dropped).
// - The receive side never waits either: the USB interrupt copies bytes into a
//   ring buffer (dropping what does not fit), lines are assembled in the main
//   loop, and a partial line older than 1 s is discarded.
//
// Transmit: two buffers alternate. A transfer that has been accepted keeps
// using its buffer until the driver accepts the next one, so a new message is
// always formatted into the other buffer.
#pragma once

#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <cstdio>

#include "daisy_seed.h"
#include "dev_link_core.h"
#include "usbd_def.h"

extern "C" USBD_HandleTypeDef hUsbDeviceFS;  // libDaisy, hid/usb.cpp

namespace devkit {

// The USB device port of the Daisy Seed (FS_INTERNAL, CDC).
struct UsbCdcTransport {
  bool Transmit(const uint8_t* data, size_t len) {
    // Only while a host has configured the device: before enumeration (no
    // cable, USB power only) and after a disconnect the CDC class data does
    // not exist, and libDaisy's CDC_Transmit_FS would read through a null
    // pointer. When the host stops reading, the previous transfer never
    // completes and the driver answers BUSY: the message is not accepted.
    if (hUsbDeviceFS.dev_state != USBD_STATE_CONFIGURED || hUsbDeviceFS.pClassData == nullptr) {
      return false;
    }
    return usb.TransmitInternal(const_cast<uint8_t*>(data), len) == daisy::UsbHandle::Result::OK;
  }
  void DelayMs(uint32_t ms) { daisy::System::Delay(ms); }

  daisy::UsbHandle usb;  // stateless: shares the global USB device
};

class DevLink {
 public:
  static constexpr size_t kTxSize = 448;
  static constexpr size_t kRxSize = 256;
  static constexpr size_t kLineSize = 96;

  DevLink() : tx_(transport_) {}

  // Brings up the USB CDC port and starts receiving. Does not wait for a host.
  void Init() {
    transport_.usb.Init(daisy::UsbHandle::FS_INTERNAL);
    transport_.usb.SetReceiveCallback(&DevLink::OnReceive, daisy::UsbHandle::FS_INTERNAL);
  }

  // Formats one message (may contain several lines, use "\r\n"). Returns
  // false and drops the message while the previous one is still waiting.
  bool Print(const char* fmt, ...) {
    va_list va;
    va_start(va, fmt);
    const bool ok = tx_.VPrint(fmt, va);
    va_end(va);
    return ok;
  }

  // True when a new message would be accepted right now.
  bool CanPrint() { return tx_.CanPrint(); }

  // Hands a waiting message to the driver if it is free.
  void Pump() { tx_.Pump(); }

  // Tries for at most max_ms to hand the waiting message to the driver
  // (before a reset). True when nothing is waiting any more.
  bool Flush(uint32_t max_ms) { return tx_.Flush(max_ms); }

  // Copies the next complete received line (without line ending) into `out`.
  // Returns false when no complete line has arrived yet.
  bool PopLine(char* out, size_t cap) { return rx().PopLine(out, cap, daisy::System::GetNow()); }

 private:
  using Receiver = LineReceiver<kRxSize, kLineSize>;
  static Receiver& rx() {
    static Receiver r;
    return r;
  }
  static void OnReceive(uint8_t* buf, uint32_t* len) { rx().Push(buf, *len); }

  UsbCdcTransport transport_;
  TxQueue<UsbCdcTransport, kTxSize> tx_;
};

}  // namespace devkit
