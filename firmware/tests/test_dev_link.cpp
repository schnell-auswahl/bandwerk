// Host tests for the hardware-free core of the USB link (devkit/firmware/dev_link_core.h).
// They pin down the release-build safety guarantees: nothing ever waits for the host.
#include <cstring>
#include <string>
#include <vector>

#include "dev_link_core.h"
#include "test_framework.h"

namespace {

// Stands in for the USB CDC driver. `accept` decides whether a transfer is taken.
struct FakeTransport {
  enum Mode { kNoHost, kBusyForever, kReading } mode = kNoHost;
  int attempts = 0;
  int delays = 0;
  int busy_after_accept = 0;  // kReading: the driver stays busy this many attempts after a transfer
  int busy_left = 0;
  std::vector<std::string> sent;
  std::vector<const uint8_t*> buffers;

  bool Transmit(const uint8_t* data, size_t len) {
    ++attempts;
    if (mode == kNoHost) return false;  // not configured: every attempt fails
    if (mode == kBusyForever) {
      // Enumerated, nobody reads: the first transfer is accepted and never completes.
      if (sent.empty()) {
        sent.emplace_back(reinterpret_cast<const char*>(data), len);
        buffers.push_back(data);
        return true;
      }
      return false;
    }
    if (busy_left > 0) {
      --busy_left;
      return false;
    }
    sent.emplace_back(reinterpret_cast<const char*>(data), len);
    buffers.push_back(data);
    busy_left = busy_after_accept;
    return true;
  }
  void DelayMs(uint32_t) { ++delays; }
};

using Queue = devkit::TxQueue<FakeTransport, 64>;
using Receiver = devkit::LineReceiver<32, 16>;

void PushText(Receiver& r, const char* s) {
  r.Push(reinterpret_cast<const uint8_t*>(s), static_cast<uint32_t>(std::strlen(s)));
}

}  // namespace

TEST(link_without_host_never_waits_and_drops) {
  // No cable / USB power only / cable pulled: the driver never accepts anything.
  FakeTransport t;
  Queue q(t);
  CHECK(q.Print("[L] %d\r\n", 1));   // formatted and parked in its buffer
  CHECK(!q.CanPrint());
  for (int i = 0; i < 100000; ++i) CHECK(!q.Print("[L] %d\r\n", i));  // dropped, returns at once
  CHECK(t.delays == 0);              // nothing ever waited
  CHECK(t.attempts <= 2 + 2 * 100000 + 1);  // one or two offers per call, no retry loop
  CHECK(t.sent.empty());
}

TEST(link_with_port_closed_parks_one_message_and_drops_the_rest) {
  // Enumerated but the port is closed (or closed mid-transfer): the transfer in flight
  // never completes and the driver answers BUSY.
  FakeTransport t;
  t.mode = FakeTransport::kBusyForever;
  Queue q(t);
  CHECK(q.Print("first\r\n"));       // handed to the driver
  CHECK(q.CanPrint());
  CHECK(q.Print("second\r\n"));      // parked: driver busy
  CHECK(!q.CanPrint());
  for (int i = 0; i < 1000; ++i) CHECK(!q.Print("more\r\n"));
  CHECK(t.sent.size() == 1);
  CHECK(t.delays == 0);
}

TEST(link_flush_gives_up_after_its_time_limit) {
  FakeTransport t;
  Queue q(t);
  q.Print("[CMD] ok dfu\r\n");
  CHECK(!q.Flush(100));
  CHECK(t.delays <= 100);            // bounded: about 100 ms on the pedal
  t.mode = FakeTransport::kReading;
  CHECK(q.Flush(100));               // a reading host takes it at once
  CHECK(t.sent.size() == 1 && t.sent[0] == "[CMD] ok dfu\r\n");
}

TEST(link_recovers_when_a_host_starts_reading) {
  FakeTransport t;
  Queue q(t);
  q.Print("old\r\n");
  q.Print("dropped\r\n");
  t.mode = FakeTransport::kReading;  // host opens the port
  CHECK(q.CanPrint());               // the parked message goes out first
  CHECK(q.Print("new\r\n"));
  CHECK(t.sent.size() == 2 && t.sent[0] == "old\r\n" && t.sent[1] == "new\r\n");
}

TEST(link_never_formats_into_the_buffer_the_driver_still_owns) {
  FakeTransport t;
  t.mode = FakeTransport::kReading;
  t.busy_after_accept = 3;
  Queue q(t);
  CHECK(q.Print("A\r\n"));           // accepted, driver owns buffer 0
  CHECK(q.Print("B\r\n"));           // formatted into buffer 1, parked (driver busy)
  const std::string a_in_flight(reinterpret_cast<const char*>(t.buffers[0]), 3);
  CHECK(a_in_flight == "A\r\n");     // still intact while in flight
  for (int i = 0; i < 5; ++i) q.Pump();
  CHECK(t.sent.size() == 2 && t.sent[1] == "B\r\n");
  CHECK(t.buffers[0] != t.buffers[1]);
}

TEST(link_truncates_long_messages) {
  FakeTransport t;
  t.mode = FakeTransport::kReading;
  Queue q(t);
  CHECK(q.Print("%s", std::string(200, 'x').c_str()));
  CHECK(t.sent.size() == 1 && t.sent[0].size() == 63);
}

TEST(receiver_assembles_lines_across_packets) {
  Receiver r;
  char out[16];
  PushText(r, "pi");
  CHECK(!r.PopLine(out, sizeof out, 0));
  PushText(r, "ng\r\n\n\r\nhello\n");
  CHECK(r.PopLine(out, sizeof out, 1) && std::strcmp(out, "ping") == 0);
  CHECK(r.PopLine(out, sizeof out, 1) && std::strcmp(out, "hello") == 0);  // empty lines skipped
  CHECK(!r.PopLine(out, sizeof out, 1));
}

TEST(receiver_cuts_long_lines_and_drops_when_full) {
  Receiver r;
  char out[16];
  PushText(r, "0123456789abcdefghij\n");  // 21 bytes, line buffer holds 15 characters
  CHECK(r.PopLine(out, sizeof out, 0) && std::strcmp(out, "0123456789abcde") == 0);
  // Ring of 32 bytes: a 40-byte burst loses its tail instead of blocking the interrupt.
  PushText(r, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
  CHECK(!r.PopLine(out, sizeof out, 1));  // newline was dropped
  PushText(r, "\nping\n");
  CHECK(r.PopLine(out, sizeof out, 2));   // the cut line ends at the next newline...
  CHECK(r.PopLine(out, sizeof out, 2) && std::strcmp(out, "ping") == 0);  // ...then normal again
}

TEST(receiver_drops_a_partial_line_left_by_a_vanished_host) {
  Receiver r;
  char out[16];
  PushText(r, "set cl_dw 25");  // host disappears mid-line
  CHECK(!r.PopLine(out, sizeof out, 1000));
  CHECK(r.partial_length() == 12);
  PushText(r, "hello\n");       // the next host, 3 s later
  CHECK(r.PopLine(out, sizeof out, 4000) && std::strcmp(out, "hello") == 0);
  // A line typed in pieces within the time limit stays together.
  PushText(r, "pi");
  CHECK(!r.PopLine(out, sizeof out, 5000));
  PushText(r, "ng\n");
  CHECK(r.PopLine(out, sizeof out, 5900) && std::strcmp(out, "ping") == 0);
}

TEST(receiver_time_limit_survives_the_millisecond_counter_wrapping) {
  Receiver r;
  char out[16];
  PushText(r, "pi");
  CHECK(!r.PopLine(out, sizeof out, 0xFFFFFF00u));
  PushText(r, "ng\n");
  CHECK(r.PopLine(out, sizeof out, 0x00000010u) && std::strcmp(out, "ping") == 0);  // 272 ms later
}
