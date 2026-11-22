#include "test_framework.h"
#include "ui/dfu_gesture.h"

using bm::DfuGesture;

namespace {
// Returns the time (ms) at which the gesture completed, or -1.
// `down(ms)` tells whether both switches are pressed at that time.
template <typename F>
int RunUntil(DfuGesture& g, int end_ms, F down) {
  for (int ms = 0; ms < end_ms; ++ms) {
    const bool d = down(ms);
    if (g.Update(d, d, ms)) return ms;
  }
  return -1;
}
}  // namespace

TEST(dfu_triggers_after_2s_of_holding_both) {
  DfuGesture g;
  const int t = RunUntil(g, 5000, [](int ms) { return ms >= 100; });
  CHECK(t == 2100);
}

TEST(dfu_does_not_trigger_when_released_early) {
  DfuGesture g;
  CHECK(RunUntil(g, 5000, [](int ms) { return ms >= 100 && ms < 1900; }) == -1);
}

TEST(dfu_needs_both_switches) {
  DfuGesture g;
  bool fired = false;
  for (int ms = 0; ms < 5000; ++ms) fired |= g.Update(true, false, ms);
  CHECK(!fired);
}

TEST(dfu_tolerates_short_dropouts) {
  DfuGesture g;
  // a 60 ms dropout after 800 ms and another one after 1500 ms
  const int t = RunUntil(g, 5000, [](int ms) {
    if (ms < 100) return false;
    if (ms >= 900 && ms < 960) return false;
    if (ms >= 1600 && ms < 1650) return false;
    return true;
  });
  CHECK(t == 2100);  // timer was not restarted
}

TEST(dfu_restarts_after_a_long_dropout) {
  DfuGesture g;
  // pressed 100..1500, released for 300 ms, pressed again from 1800 on
  const int t = RunUntil(g, 6000, [](int ms) {
    return (ms >= 100 && ms < 1500) || ms >= 1800;
  });
  CHECK(t == 3800);  // 2 s counted from the second press
}

TEST(dfu_state_reporting) {
  DfuGesture g;
  CHECK(!g.active());
  g.Update(true, true, 1000);
  CHECK(g.active());
  CHECK(g.held_ms(1500) == 500);
  g.Update(false, false, 1100);
  CHECK(g.active());  // 100 ms dropout: still within the grace time
  g.Update(false, false, 1200);
  CHECK(!g.active());  // 200 ms: gesture is over
}
