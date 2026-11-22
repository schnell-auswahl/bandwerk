#include "test_framework.h"
#include "ui/loop_calibration.h"

using namespace bm;

TEST(power_up_in_bridge_does_not_measure) {
  LoopCalibrator c;
  c.Init(LoopMode::kBridge, 0);
  bool started = false;
  for (uint32_t t = 0; t < 10000; t += 5) started = started || c.Update(LoopMode::kBridge, t);
  CHECK(!started);
}

TEST(power_up_in_loop_measures_after_one_second) {
  LoopCalibrator c;
  c.Init(LoopMode::kLoop, 100);
  CHECK(!c.Update(LoopMode::kLoop, 1099));
  CHECK(c.Update(LoopMode::kLoop, 1100));
  CHECK(c.measuring());
  CHECK(!c.Update(LoopMode::kLoop, 1105));  // only once
  CHECK(c.last_result() == -1);
  CHECK(c.OnResult(true, 170.9f, 1200));
  CHECK(!c.measuring());
  CHECK(c.last_result() == 1);
  bool again = false;
  for (uint32_t t = 1200; t < 60000; t += 5) again = again || c.Update(LoopMode::kLoop, t);
  CHECK(!again);  // a good result is not repeated
}

TEST(bridge_to_loop_measures_at_once_loop_to_inverted_does_not) {
  LoopCalibrator c;
  c.Init(LoopMode::kBridge, 0);
  CHECK(c.Update(LoopMode::kLoop, 5000));
  CHECK(c.OnResult(true, 43.0f, 5100));
  CHECK(!c.Update(LoopMode::kLoopInverted, 6000));  // same loop, same latency
  CHECK(!c.Update(LoopMode::kLoop, 7000));
  CHECK(!c.Update(LoopMode::kBridge, 8000));
  CHECK(c.Update(LoopMode::kLoopInverted, 9000));  // from Bridge into a loop mode: measure
}

TEST(failure_blinks_keeps_old_value_and_retries_every_2_s_up_to_15_times) {
  LoopCalibrator c;
  c.Init(LoopMode::kBridge, 0);
  uint32_t t = 1000;
  CHECK(c.Update(LoopMode::kLoop, t));
  int starts = 1;
  CHECK(!c.OnResult(false, 0.0f, t + 100));
  float led = -1.0f;
  CHECK(c.Led(t + 200, &led));
  CHECK(!c.Led(t + 100 + LoopCalibrator::kWarnMs, &led));
  for (t = t + 101; t < 100000; ++t) {
    if (c.Update(LoopMode::kLoop, t)) {
      ++starts;
      CHECK(!c.OnResult(false, 0.0f, t + 50));
    }
  }
  CHECK(starts == LoopCalibrator::kMaxTries);
}

TEST(retries_stop_when_switched_back_to_bridge_and_a_late_success_counts) {
  LoopCalibrator c;
  c.Init(LoopMode::kLoop, 0);
  CHECK(c.Update(LoopMode::kLoop, 1000));
  CHECK(!c.OnResult(false, 0.0f, 1100));      // effect still booting
  CHECK(c.Update(LoopMode::kLoop, 3100));      // retry after 2 s
  CHECK(c.OnResult(true, 171.0f, 3200));       // now it answers
  CHECK(!c.pending());
  c.Init(LoopMode::kLoop, 0);
  CHECK(c.Update(LoopMode::kLoop, 1000));
  CHECK(!c.OnResult(false, 0.0f, 1100));
  bool started = false;
  for (uint32_t t = 1100; t < 30000; t += 5) started = started || c.Update(LoopMode::kBridge, t);
  CHECK(!started);
}

TEST(implausible_lags_are_rejected) {
  LoopCalibrator c;
  c.Init(LoopMode::kLoop, 0);
  CHECK(c.Update(LoopMode::kLoop, 1000));
  CHECK(!c.OnResult(true, 2.0f, 1100));     // shorter than the converters alone
  CHECK(c.Update(LoopMode::kLoop, 3100));
  CHECK(!c.OnResult(true, 1010.0f, 3200));  // beyond the delay buffer
}
