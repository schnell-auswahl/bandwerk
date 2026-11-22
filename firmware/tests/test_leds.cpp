#include <initializer_list>

#include "test_framework.h"
#include "ui/leds.h"

using namespace bm;

namespace {
LedInputs In(Page page, bool oct = false, bool drv = false) {
  LedInputs i;
  i.page = page;
  i.octave_on = oct;
  i.drive_on = drv;
  return i;
}
}  // namespace

TEST(bypass_turns_everything_off) {
  LedLogic l;
  LedInputs i = In(Page::kComp, true, true);
  i.bypass = true;
  i.takeover_active = true;
  float o[2];
  for (uint32_t t = 0; t < 3000; t += 13) {
    l.Compute(i, t, o);
    CHECK(o[0] == 0.0f && o[1] == 0.0f);
  }
}

TEST(effect_on_is_solid_on_every_page) {
  for (Page p : {Page::kComp, Page::kLoop, Page::kOctave, Page::kDrive}) {
    LedLogic l;
    float o[2];
    for (uint32_t t = 0; t < 3000; t += 7) {
      l.Compute(In(p, true, true), t, o);
      CHECK(o[0] == 1.0f && o[1] == 1.0f);
    }
  }
}

TEST(effect_off_breathes_between_off_and_dim_both_leds_in_step) {
  LedLogic l;
  float o[2];
  float lo = 1.0f, hi = 0.0f;
  bool in_step = true;
  for (uint32_t t = 0; t < 5000; t += 5) {  // two periods
    l.Compute(In(Page::kDrive), t, o);
    lo = fminf(lo, o[0]);
    hi = fmaxf(hi, o[0]);
    in_step = in_step && o[0] == o[1];
  }
  CHECK(lo < 0.005f);
  CHECK_NEAR(hi, LedLogic::kBreathMax, 0.005);
  CHECK(in_step);
  l.Compute(In(Page::kComp), 1250, o);  // half a period: brightest
  CHECK_NEAR(o[0], LedLogic::kBreathMax, 1e-4);
}

TEST(one_effect_on_one_off_is_clearly_different) {
  LedLogic l;
  float o[2];
  for (uint32_t t = 0; t < 3000; t += 11) {
    l.Compute(In(Page::kOctave, true, false), t, o);
    CHECK(o[0] == 1.0f && o[1] <= LedLogic::kBreathMax + 1e-6f);
  }
}

namespace {
// LED values during a page blink, sampled in the middle of each 100 ms step.
void Blink(Page p, bool oct, bool drv, float l1[4], float l2[4]) {
  LedLogic l;
  float o[2];
  l.NotifyPage(p, 1000);
  for (int k = 0; k < 4; ++k) {
    l.Compute(In(p, oct, drv), 1000 + 50 + 100 * k, o);
    l1[k] = o[0];
    l2[k] = o[1];
  }
}
}  // namespace

TEST(page_blinks_comp_both_loop_alternating_octave_led1_drive_led2) {
  float a[4], b[4];
  Blink(Page::kComp, false, false, a, b);
  CHECK(a[0] == 1 && a[1] == 0 && a[2] == 1 && a[3] == 0);
  CHECK(b[0] == 1 && b[1] == 0 && b[2] == 1 && b[3] == 0);
  Blink(Page::kLoop, false, false, a, b);
  CHECK(a[0] == 1 && a[1] == 0 && a[2] == 1 && a[3] == 0);
  CHECK(b[0] == 0 && b[1] == 1 && b[2] == 0 && b[3] == 1);
  Blink(Page::kOctave, true, true, a, b);  // even with the effect on: the gaps are visible
  CHECK(a[0] == 1 && a[1] == 0 && a[2] == 1 && a[3] == 0);
  CHECK(b[0] == 1 && b[1] == 1 && b[2] == 1 && b[3] == 1);  // LED 2 keeps its state (drive on)
  Blink(Page::kDrive, false, false, a, b);
  CHECK(b[0] == 1 && b[1] == 0 && b[2] == 1 && b[3] == 0);
  CHECK(a[0] <= LedLogic::kBreathMax && a[2] <= LedLogic::kBreathMax);  // LED 1 just breathes
}

TEST(page_blink_ends_after_400_ms) {
  LedLogic l;
  float o[2];
  l.NotifyPage(Page::kComp, 1000);
  l.Compute(In(Page::kComp, true, true), 1050, o);
  CHECK(o[0] == 1.0f);
  l.Compute(In(Page::kComp, true, true), 1150, o);
  CHECK(o[0] == 0.0f);
  l.Compute(In(Page::kComp, true, true), 1400, o);
  CHECK(o[0] == 1.0f && o[1] == 1.0f);  // base again: effects on
  l.Compute(In(Page::kComp, true, true), 1450, o);
  CHECK(o[0] == 1.0f && o[1] == 1.0f);
}

namespace {
LedInputs Pickup(Page page, float distance, bool caught = false) {
  LedInputs i = In(page);
  i.takeover_active = true;
  i.takeover_caught = caught;
  i.takeover_distance = distance;
  return i;
}
// Counts LED 1 rising edges while holding the input for `ms` milliseconds.
int Edges(LedLogic& l, const LedInputs& in, uint32_t t0, uint32_t ms) {
  float o[2];
  float prev = 0.0f;
  int edges = 0;
  for (uint32_t t = t0; t < t0 + ms; ++t) {
    l.Compute(in, t, o);
    if (o[0] > 0.5f && prev < 0.5f) ++edges;
    prev = o[0];
  }
  return edges;
}
}  // namespace

TEST(pickup_blink_rate_goes_from_slow_to_fast_as_the_knob_gets_closer) {
  CHECK_NEAR(LedLogic::BlinkHz(1.0f), 1.0, 1e-6);
  CHECK_NEAR(LedLogic::BlinkHz(0.4f), 1.0, 1e-6);
  CHECK_NEAR(LedLogic::BlinkHz(0.0f), 10.0, 1e-6);
  float prev = 0.0f;
  for (float d = 1.0f; d >= 0.0f; d -= 0.02f) {
    const float hz = LedLogic::BlinkHz(d);
    CHECK(hz >= prev);
    prev = hz;
  }
  LedLogic far_l, near_l;
  const int far_edges = Edges(far_l, Pickup(Page::kLoop, 0.6f), 1000, 4000);
  const int near_edges = Edges(near_l, Pickup(Page::kLoop, 0.05f), 1000, 4000);
  CHECK(far_edges >= 3 && far_edges <= 5);
  CHECK(near_edges >= 30 && near_edges <= 40);
}

TEST(pickup_blink_is_phase_continuous_while_the_rate_changes) {
  LedLogic l;
  float o[2];
  int edges = 0;
  float prev = 0.0f;
  for (uint32_t t = 0; t < 3000; ++t) {
    const float d = 0.5f - 0.48f * static_cast<float>(t) / 3000.0f;
    l.Compute(Pickup(Page::kComp, d), t, o);
    if (o[0] > 0.5f && prev < 0.5f) ++edges;
    prev = o[0];
  }
  CHECK(edges >= 6 && edges <= 18);
}

TEST(pickup_only_uses_led_1) {
  LedLogic with_pickup, without;
  float a[2], b[2];
  for (uint32_t t = 0; t < 2000; t += 7) {
    with_pickup.Compute(Pickup(Page::kLoop, 0.3f), t, a);
    without.Compute(In(Page::kLoop), t, b);
    CHECK_NEAR(a[1], b[1], 1e-6);
  }
}

TEST(pickup_caught_shows_led_1_solid_then_back_to_the_base) {
  LedLogic l;
  float o[2];
  for (uint32_t t = 0; t < 1500; t += 3) {
    l.Compute(Pickup(Page::kOctave, 0.0f, true), t, o);
    CHECK(o[0] == 1.0f);
  }
  l.Compute(In(Page::kComp), 1250 + 2500, o);  // released: breathing again
  CHECK_NEAR(o[0], LedLogic::kBreathMax, 1e-4);
  l.Compute(In(Page::kComp, true, false), 3800, o);
  CHECK(o[0] == 1.0f);
}

TEST(bypass_beats_pickup_and_page_blink) {
  LedLogic l;
  float o[2];
  l.NotifyPage(Page::kComp, 0);
  LedInputs i = Pickup(Page::kComp, 0.0f, true);
  i.bypass = true;
  l.Compute(i, 50, o);
  CHECK(o[0] == 0.0f && o[1] == 0.0f);
}
