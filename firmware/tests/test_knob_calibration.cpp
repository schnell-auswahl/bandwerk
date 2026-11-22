#include "test_framework.h"
#include "ui/knob_calibration.h"

using namespace bm;

TEST(the_measured_end_stops_map_to_exactly_0_and_100_percent) {
  for (int i = 0; i < 6; ++i) {
    CHECK(NormalizeKnob(i, kKnobRawMin[i]) == 0.0f);
    CHECK(NormalizeKnob(i, kKnobRawMax[i]) == 1.0f);   // 0.969 raw is 100 %
    CHECK(NormalizeKnob(i, 0.969f) == 1.0f);
  }
}

TEST(a_little_noise_at_the_end_stops_does_not_lose_the_ends) {
  // ADC noise / supply drift of a few thousandths still reads as the end
  CHECK(NormalizeKnob(0, 0.965f) == 1.0f);
  CHECK(NormalizeKnob(0, 0.004f) == 0.0f);
  CHECK(NormalizeKnob(0, 0.0f) == 0.0f);
  CHECK(NormalizeKnob(0, 1.0f) == 1.0f);   // above the range: clamped
  CHECK(NormalizeKnob(0, -0.05f) == 0.0f);
}

TEST(the_middle_of_the_travel_is_12_oclock) {
  const float mid_raw = 0.5f * (kKnobRawMin[0] + kKnobRawMax[0]);
  CHECK_NEAR(NormalizeKnob(0, mid_raw), 0.5, 1e-4);
}

TEST(the_mapping_is_linear_and_monotonic) {
  float prev = -1.0f;
  for (float raw = 0.0f; raw <= 1.0f; raw += 0.001f) {
    const float v = NormalizeKnob(0, raw);
    CHECK(v >= prev);
    prev = v;
  }
  // inside the travel it is a straight line between the two margins
  const float a = NormalizeKnob(0, 0.30f), b = NormalizeKnob(0, 0.60f), c = NormalizeKnob(0, 0.90f);
  CHECK_NEAR(c - b, b - a, 1e-4);
}

TEST(bad_constants_do_not_divide_by_zero) {
  CHECK(NormalizeKnob(0.5f, 0.5f, 0.5f) == 0.5f);   // hi <= lo: raw passes through, clamped
  CHECK(NormalizeKnob(1.5f, 0.9f, 0.1f) == 1.0f);
}

TEST(the_pickup_value_100_percent_can_be_caught_with_the_calibrated_knob) {
  // regression for the reported problem: stored value 1.0, knob at its right stop
  const float knob = NormalizeKnob(3, 0.969f);
  CHECK(knob >= 1.0f - 0.02f);   // within the soft takeover tolerance of 1.0
}
