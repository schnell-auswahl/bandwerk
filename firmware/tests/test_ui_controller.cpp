#include <cmath>

#include "test_framework.h"
#include "ui/ui_controller.h"

using namespace bm;

namespace {

// Drives a UiController with a simulated 1 ms main loop.
struct Rig {
  UiController ui;
  UiInputs in;
  uint32_t now = 1000;

  explicit Rig(bool bypass_enabled = true) {
    UiConfig cfg;
    cfg.bypass_gesture_enabled = bypass_enabled;
    for (int i = 0; i < 6; ++i) in.knob[i] = 0.5f;
    in.now_ms = now;
    ui.Init(in, Params(), cfg);
  }
  void Run(uint32_t ms) {
    for (uint32_t i = 0; i < ms; ++i) {
      ++now;
      in.now_ms = now;
      ui.Update(in);
    }
  }
  void Toggle(int idx, TogglePos p) { in.toggle[idx] = p; }
  void Press(int fs, uint32_t ms) {
    in.fs[fs] = true;
    Run(ms);
    in.fs[fs] = false;
    Run(50);
  }
  // Moves a knob in small steps like a hand would.
  void Turn(int knob, float to, int steps = 40) {
    const float from = in.knob[knob];
    for (int s = 1; s <= steps; ++s) {
      in.knob[knob] = from + (to - from) * static_cast<float>(s) / steps;
      Run(5);
    }
  }
};

}  // namespace

TEST(starts_on_comp_and_applies_switch_positions_without_page_change) {
  UiController ui;
  UiInputs in;
  in.toggle[0] = TogglePos::kUp;
  in.toggle[1] = TogglePos::kDown;
  in.toggle[2] = TogglePos::kDown;
  in.now_ms = 5000;
  ui.Init(in, Params(), UiConfig());
  CHECK(ui.page() == Page::kComp);
  CHECK(ui.band() == BandSel::kHigh);
  CHECK(ui.loop_mode() == LoopMode::kLoopInverted);
  CHECK(ui.drive_type() == DriveType::kFuzz);
  for (int i = 0; i < 1000; ++i) {
    in.now_ms++;
    ui.Update(in);
  }
  CHECK(ui.page() == Page::kComp);  // no page change from the initial state
}

TEST(master_and_crossover_follow_knobs_immediately) {
  Rig r;
  r.Turn(0, 0.8f);
  CHECK_NEAR(r.ui.params().master, 0.8, 0.01);
  r.Turn(2, 0.2f);
  CHECK_NEAR(r.ui.params().crossover, 0.2, 0.01);
  // also on another page
  r.Toggle(2, TogglePos::kUp);
  r.Run(400);
  CHECK(r.ui.page() == Page::kDrive);
  r.Turn(0, 0.3f);
  CHECK_NEAR(r.ui.params().master, 0.3, 0.01);
}

TEST(toggle_moves_call_up_pages_at_once_but_apply_audio_after_300ms) {
  Rig r;
  r.Toggle(1, TogglePos::kDown);  // S2 down = loop + phase
  r.Run(40);
  CHECK(r.ui.page() == Page::kLoop);
  CHECK(r.ui.loop_mode() == LoopMode::kLoop);  // not yet
  r.Run(300);
  CHECK(r.ui.loop_mode() == LoopMode::kLoopInverted);
  r.Toggle(2, TogglePos::kDown);
  r.Run(40);
  CHECK(r.ui.page() == Page::kDrive);
  CHECK(r.ui.drive_type() == DriveType::kDistortion);
  r.Run(300);
  CHECK(r.ui.drive_type() == DriveType::kFuzz);
}

TEST(quick_wiggle_calls_up_page_without_changing_routing) {
  Rig r;
  r.Toggle(1, TogglePos::kUp);
  r.Run(120);
  r.Toggle(1, TogglePos::kMiddle);
  r.Run(600);
  CHECK(r.ui.page() == Page::kLoop);
  CHECK(r.ui.loop_mode() == LoopMode::kLoop);  // unchanged
}

TEST(footswitch_short_toggles_and_hold_opens_page) {
  Rig r;
  CHECK(!r.ui.params().octave_on);
  r.Press(0, 100);
  CHECK(r.ui.params().octave_on);
  CHECK(r.ui.page() == Page::kOctave);  // switching on opens the page
  r.Press(0, 100);
  CHECK(!r.ui.params().octave_on);
  r.Press(1, 100);
  CHECK(r.ui.params().drive_on);
  r.Press(0, 700);
  CHECK(r.ui.page() == Page::kOctave);
  CHECK(!r.ui.params().octave_on);  // hold does not toggle
  r.Press(1, 700);
  CHECK(r.ui.page() == Page::kDrive);
  CHECK(r.ui.params().drive_on);
}

TEST(takeover_catches_on_crossing_and_both_bands_follow) {
  Rig r;  // page COMP, S1 middle = both bands, K2 = ratio
  const Params before = r.ui.params();
  // knob K2 sits at 0.5, stored ratios are ~0.41/0.43: mean ~0.42 -> within 0.08
  // move away first so a catch needs real crossing
  r.in.knob[1] = 0.9f;
  r.Run(50);
  CHECK(!r.ui.takeover_pending() == false);
  CHECK_NEAR(r.ui.params().comp[0].ratio, before.comp[0].ratio, 1e-6);
  r.Turn(1, 0.7f);   // still above the stored mean: no effect
  CHECK_NEAR(r.ui.params().comp[0].ratio, before.comp[0].ratio, 1e-6);
  CHECK_NEAR(r.ui.params().comp[1].ratio, before.comp[1].ratio, 1e-6);
  r.Turn(1, 0.1f);   // crosses the stored value
  CHECK_NEAR(r.ui.params().comp[0].ratio, 0.1, 0.01);
  CHECK_NEAR(r.ui.params().comp[1].ratio, 0.1, 0.01);  // both set to the knob
}

TEST(takeover_edits_only_the_selected_band) {
  Rig r;
  r.Toggle(0, TogglePos::kUp);  // HIGH
  r.Run(400);
  CHECK(r.ui.band() == BandSel::kHigh);
  const Params before = r.ui.params();
  r.in.knob[4] = 0.95f;  // K5 = release, far from stored
  r.Run(50);
  r.Turn(4, 0.1f);       // crosses
  CHECK_NEAR(r.ui.params().comp[0].release, 0.1, 0.01);
  CHECK_NEAR(r.ui.params().comp[1].release, before.comp[1].release, 1e-6);
}

TEST(page_change_resets_takeover_and_keeps_values) {
  Rig r;
  r.Toggle(1, TogglePos::kMiddle);  // no change, stay
  r.in.knob[3] = 0.9f;              // K4 far away
  r.Run(100);
  r.Toggle(1, TogglePos::kUp);      // page LOOP
  r.Run(400);
  CHECK(r.ui.page() == Page::kLoop);
  const float mix_before = r.ui.params().loop_mix;  // stored 1.0
  CHECK(!r.ui.takeover_pending());  // nothing touched yet: no blinking
  r.in.knob[3] = 0.3f;              // K4 turned, but stored mix = 1.0 not crossed
  r.Run(50);
  CHECK(r.ui.takeover_pending());   // touched and not caught
  CHECK_NEAR(r.ui.params().loop_mix, mix_before, 1e-6);
  r.Turn(3, 1.0f);                  // crosses/approaches 1.0
  CHECK_NEAR(r.ui.params().loop_mix, 1.0, 0.02);
}

TEST(caught_knobs_do_not_change_stored_values_on_page_change) {
  Rig r;
  r.in.knob[3] = 0.5f;
  r.Run(100);
  r.Turn(3, 0.8f);  // drag COMP dry/wet (both bands) after catching
  const float dw_high = r.ui.params().comp[0].dry_wet;
  r.Toggle(2, TogglePos::kUp);  // page DRIVE
  r.Run(400);
  CHECK(r.ui.page() == Page::kDrive);
  r.Turn(3, 0.2f);  // K4 = band mix now, must not touch COMP dry/wet
  CHECK_NEAR(r.ui.params().comp[0].dry_wet, dw_high, 1e-6);
}

TEST(s1_change_resets_takeover_and_old_band_is_not_edited_while_settling) {
  Rig r;
  r.Toggle(0, TogglePos::kUp);  // HIGH
  r.Run(400);
  const Params before = r.ui.params();
  r.in.knob[1] = 0.95f;
  r.Run(50);
  r.Turn(1, 0.1f);  // catch K2 on high ratio
  CHECK_NEAR(r.ui.params().comp[0].ratio, 0.1, 0.01);
  r.Toggle(0, TogglePos::kDown);  // LOW selected, settling for 300 ms
  r.Run(100);
  r.Turn(1, 0.6f);  // turning during settling must not edit the high band
  CHECK_NEAR(r.ui.params().comp[0].ratio, 0.1, 0.012);
  r.Run(400);
  CHECK(r.ui.band() == BandSel::kLow);
  CHECK_NEAR(r.ui.params().comp[1].ratio, before.comp[1].ratio, 1e-6);
  CHECK(!r.ui.takeover_pending());  // reset: nothing touched since
  r.Turn(1, 0.9f);                  // touch K2 again, low ratio not picked up yet
  CHECK_NEAR(r.ui.params().comp[1].ratio, before.comp[1].ratio, 1e-6);
  CHECK(r.ui.takeover_pending());
}

TEST(untouched_knobs_never_make_the_led_blink) {
  Rig r;
  // All knobs sit at 0.5; the stored values elsewhere are far away on LOOP
  // (mix 1.0, trim 0.0), but nobody touches them.
  r.Toggle(1, TogglePos::kUp);
  r.Run(600);
  CHECK(r.ui.page() == Page::kLoop);
  CHECK(!r.ui.takeover_pending());
  r.Run(1000);
  CHECK(!r.ui.takeover_pending());
}

TEST(blinking_stops_when_the_touched_knob_is_caught) {
  Rig r;
  r.Toggle(1, TogglePos::kUp);
  r.Run(600);
  r.in.knob[3] = 0.2f;  // touch K4 (stored mix 1.0)
  r.Run(50);
  CHECK(r.ui.takeover_pending());
  r.Turn(3, 1.0f);      // reaches the stored value
  CHECK(!r.ui.takeover_pending());
}

TEST(small_knob_jitter_does_not_count_as_touch) {
  Rig r;
  r.Toggle(1, TogglePos::kUp);
  r.Run(600);
  r.in.knob[3] = 0.51f;  // 1 % wobble
  r.Run(100);
  CHECK(!r.ui.takeover_pending());
}

TEST(bypass_gesture_toggles_when_enabled) {
  Rig r(true);
  r.in.fs[0] = r.in.fs[1] = true;
  r.Run(300);
  r.in.fs[0] = r.in.fs[1] = false;
  r.Run(100);
  CHECK(r.ui.bypass());
  CHECK(r.ui.led(0) == 0.0f && r.ui.led(1) == 0.0f);
  CHECK(!r.ui.params().octave_on && !r.ui.params().drive_on);  // no singles
  r.in.fs[0] = r.in.fs[1] = true;
  r.Run(300);
  r.in.fs[0] = r.in.fs[1] = false;
  r.Run(100);
  CHECK(!r.ui.bypass());
}

TEST(bypass_gesture_disabled_still_suppresses_single_functions) {
  Rig r(false);
  r.in.fs[0] = r.in.fs[1] = true;
  r.Run(300);
  r.in.fs[0] = r.in.fs[1] = false;
  r.Run(100);
  CHECK(!r.ui.bypass());
  CHECK(!r.ui.params().octave_on && !r.ui.params().drive_on);
}

TEST(revision_increments_on_changes_only) {
  Rig r;
  r.Run(200);
  const uint32_t rev = r.ui.revision();
  r.Run(500);
  CHECK(r.ui.revision() == rev);  // idle: nothing to report
  r.Press(0, 100);
  CHECK(r.ui.revision() > rev);
}

// --- LED 1 while a knob is picked up (blinks faster the closer, solid when
// --- caught, back to normal after letting go)

TEST(pickup_led_slow_far_away_fast_close_solid_when_caught_normal_after_release) {
  Rig r;
  r.Toggle(1, TogglePos::kUp);  // page LOOP (octave off: LED 1 breathes dimly)
  r.Run(600);
  CHECK(r.ui.page() == Page::kLoop);
  r.in.knob[3] = 0.5f;  // K4 = loop mix, stored value is 1.0
  r.Run(100);

  // sweep K4 from 0.2 up to the stored 1.0 over 4 s and record LED 1
  int edges_first_second = 0, edges_last_second = 0;
  float prev = 0.0f;
  bool solid_after_catch = true;
  bool caught = false;
  const int kSteps = 4000;
  for (int i = 0; i < kSteps; ++i) {
    r.in.knob[3] = 0.2f + 0.8f * static_cast<float>(i) / kSteps;
    r.Run(1);
    const float led = r.ui.led(0);
    const bool rising = led > 0.5f && prev < 0.5f;
    if (!caught && i < 1000 && rising) ++edges_first_second;
    if (!caught && i >= 2900 && rising) ++edges_last_second;
    if (r.ui.caught_mask() & 2) {  // slot 1 = K4
      caught = true;
    }
    if (caught && led != 1.0f) solid_after_catch = false;
    prev = led;
  }
  CHECK(caught);
  CHECK(edges_first_second <= 2);    // far away: about 1 Hz
  CHECK(edges_last_second >= 4);     // close: clearly faster
  CHECK(solid_after_catch);          // once caught: constantly on
  std::printf("    blink edges: first second %d, last second before catch %d\n",
              edges_first_second, edges_last_second);

  // still on while the knob rests for less than the hold time
  r.Run(500);
  CHECK(r.ui.led(0) == 1.0f);
  // after letting go: back to the base display (octave off: breathing, dim)
  r.Run(700);
  float lo = 1.0f, hi = 0.0f;
  for (int i = 0; i < 3000; ++i) {
    r.Run(1);
    lo = r.ui.led(0) < lo ? r.ui.led(0) : lo;
    hi = r.ui.led(0) > hi ? r.ui.led(0) : hi;
  }
  CHECK(lo < 0.01f && hi > 0.1f && hi <= LedLogic::kBreathMax + 1e-6f);
}

TEST(pickup_led_does_not_touch_led_2) {
  Rig r;
  r.Toggle(1, TogglePos::kUp);
  r.Run(600);
  // a second, identical controller without any knob movement as reference
  Rig ref;
  ref.Toggle(1, TogglePos::kUp);
  ref.Run(600);
  r.in.knob[3] = 0.9f;
  float worst = 0.0f;
  for (int i = 0; i < 800; ++i) {
    r.Run(1);
    ref.Run(1);
    const float d = fabsf(r.ui.led(1) - ref.ui.led(1));
    worst = d > worst ? d : worst;
  }
  CHECK(worst < 0.01f);  // LED 2 keeps its display exactly as without pickup
}

TEST(a_caught_knob_that_keeps_moving_keeps_led_1_on) {
  Rig r;
  r.Run(300);
  // page COMP, K2 within the tolerance of its stored value: caught at once
  r.Turn(1, 0.45f);
  r.Turn(1, 0.55f, 20);
  CHECK(r.ui.led(0) == 1.0f);   // editing: LED 1 on although octave is off
  r.Run(1200);
  CHECK(r.ui.led(0) <= LedLogic::kBreathMax + 1e-6f);   // released: breathing (octave off)
}

TEST(pickup_led_stays_normal_while_nothing_is_moved) {
  Rig r;
  r.Toggle(1, TogglePos::kUp);
  r.Run(600);
  Rig ref;
  ref.Toggle(1, TogglePos::kUp);
  ref.Run(600);
  float worst = 0.0f;
  for (int i = 0; i < 2000; ++i) {
    r.Run(1);
    ref.Run(1);
    worst = fmaxf(worst, fabsf(r.ui.led(0) - ref.ui.led(0)));
  }
  CHECK(worst < 1e-6f);
}

TEST(remote_set_survives_a_knob_that_had_already_picked_up) {
  Rig r;
  // Page COMP, high band (S1 up): K4 = dry/wet. Pick the stored value up first.
  r.Turn(3, 0.62f);
  r.Run(50);
  CHECK(std::fabs(r.ui.params().comp[0].dry_wet - 0.62f) < 0.02f);  // knob in control now
  CHECK(r.ui.RemoteSetParam(5, 0.0f));
  r.Run(2000);  // knob stands still at 0.62
  CHECK(r.ui.params().comp[0].dry_wet == 0.0f);
  // A real turn across the value takes over again.
  r.Turn(3, 0.0f);
  r.Run(50);
  CHECK(r.ui.params().comp[0].dry_wet < 0.05f);
}

TEST(remote_defaults_are_not_overwritten_by_caught_knobs) {
  Rig r;
  r.Turn(3, 0.9f);
  r.Run(50);
  r.ui.RemoteDefaults();
  r.Run(1000);
  CHECK(std::fabs(r.ui.params().comp[0].dry_wet - Params().comp[0].dry_wet) < 1e-6f);
}

TEST(restored_crossover_must_be_picked_up_but_master_follows_the_knob) {
  Params stored;
  stored.crossover = 0.8f;
  stored.master = 0.9f;
  UiController ui;
  UiInputs in;
  for (int i = 0; i < 6; ++i) in.knob[i] = 0.3f;
  in.now_ms = 1000;
  UiConfig cfg;
  cfg.restore_crossover = true;
  cfg.start_page = Page::kDrive;
  ui.Init(in, stored, cfg);
  auto run = [&](int ms) { for (int i = 0; i < ms; ++i) { in.now_ms++; ui.Update(in); } };
  run(500);
  CHECK(ui.page() == Page::kDrive);
  CHECK(ui.params().crossover == 0.8f);
  CHECK(std::fabs(ui.params().master - 0.3f) < 1e-6f);
  CHECK(!ui.takeover_pending());

  in.knob[2] = 0.5f;  // moved, not there yet: value stays, the pickup is indicated
  run(50);
  CHECK(ui.params().crossover == 0.8f);
  CHECK(ui.takeover_pending());
  run(1100);          // left alone: the indication ends, the value still stays
  CHECK(!ui.takeover_pending());
  CHECK(ui.params().crossover == 0.8f);

  in.knob[2] = 0.9f;  // crossed: the knob is in control
  run(50);
  CHECK(std::fabs(ui.params().crossover - 0.9f) < 1e-6f);
  CHECK(!ui.takeover_pending());
  in.knob[2] = 0.2f;  // and stays in control
  run(50);
  CHECK(std::fabs(ui.params().crossover - 0.2f) < 1e-6f);
}

TEST(a_caught_crossover_knob_stays_live_across_page_changes_and_leaves_the_led_alone) {
  Rig r;
  r.Press(0, 700);  // to page OCTAVE
  CHECK(r.ui.page() == Page::kOctave);
  r.Run(1200);
  r.in.knob[2] = 0.7f;
  r.Run(50);
  CHECK(std::fabs(r.ui.params().crossover - 0.7f) < 1e-6f);  // no pickup needed
  CHECK(!r.ui.takeover_pending());
}

TEST(without_restore_both_global_knobs_are_read_at_start) {
  UiController ui;
  UiInputs in;
  for (int i = 0; i < 6; ++i) in.knob[i] = 0.3f;
  in.now_ms = 1000;
  Params stored;
  stored.crossover = 0.8f;
  ui.Init(in, stored, UiConfig());
  CHECK(std::fabs(ui.params().crossover - 0.3f) < 1e-6f);
}

TEST(switching_an_effect_on_opens_its_page_switching_off_stays) {
  Rig r;
  CHECK(r.ui.page() == Page::kComp);
  r.Press(0, 100);  // FS1 short: octave on
  CHECK(r.ui.params().octave_on);
  CHECK(r.ui.page() == Page::kOctave);
  r.Press(1, 100);  // FS2 short: drive on
  CHECK(r.ui.params().drive_on);
  CHECK(r.ui.page() == Page::kDrive);
  r.Press(0, 100);  // octave off: stay on DRIVE
  CHECK(!r.ui.params().octave_on);
  CHECK(r.ui.page() == Page::kDrive);
  r.Press(1, 100);  // drive off: stay on DRIVE
  CHECK(!r.ui.params().drive_on);
  CHECK(r.ui.page() == Page::kDrive);
}

TEST(holding_opens_the_page_without_changing_the_effect) {
  Rig r;
  r.Press(0, 700);  // FS1 held
  CHECK(r.ui.page() == Page::kOctave);
  CHECK(!r.ui.params().octave_on);
  r.Press(1, 700);  // FS2 held
  CHECK(r.ui.page() == Page::kDrive);
  CHECK(!r.ui.params().drive_on);
}

TEST(effect_switched_on_shows_solid_after_the_page_blink) {
  Rig r;
  r.Press(1, 100);  // FS2 short: drive on, page DRIVE
  CHECK(r.ui.page() == Page::kDrive);
  r.Run(400);
  for (int i = 0; i < 3000; ++i) {
    r.Run(1);
    CHECK(r.ui.led(1) == 1.0f);                              // drive on: solid
    CHECK(r.ui.led(0) <= LedLogic::kBreathMax + 1e-6f);      // octave off: dim breathing
  }
}

TEST(holding_a_footswitch_blinks_its_led_twice) {
  Rig r;
  r.in.fs[0] = true;
  r.Run(520);  // hold fires at 500 ms
  int off = 0, on = 0;
  for (int i = 0; i < 400; ++i) {
    r.Run(1);
    if (r.ui.led(0) == 1.0f) ++on;
    if (r.ui.led(0) == 0.0f) ++off;
  }
  r.in.fs[0] = false;
  r.Run(50);
  CHECK(r.ui.page() == Page::kOctave);
  CHECK(on > 100 && off > 100);  // two blinks
}
