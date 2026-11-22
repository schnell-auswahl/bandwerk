#include "test_framework.h"
#include "ui/footswitch.h"

using bm::FootswitchEvents;
using bm::FootswitchLogic;

namespace {

struct Totals {
  int shorts[2] = {0, 0};
  int holds[2] = {0, 0};
  int bypass = 0;
  uint32_t hold_time[2] = {0, 0};
};

// Scripted press interval of one switch: down in [down, up).
struct Iv {
  uint32_t down;
  uint32_t up;
};

Totals Run(Iv sw0, Iv sw1, uint32_t end_ms = 4000) {
  FootswitchLogic l;
  Totals t;
  for (uint32_t ms = 0; ms < end_ms; ++ms) {
    const bool a = ms >= sw0.down && ms < sw0.up;
    const bool b = ms >= sw1.down && ms < sw1.up;
    const FootswitchEvents e = l.Update(a, b, ms);
    for (int i = 0; i < 2; ++i) {
      t.shorts[i] += e.fs[i] == FootswitchEvents::kShort;
      if (e.fs[i] == FootswitchEvents::kHold) {
        ++t.holds[i];
        t.hold_time[i] = ms;
      }
    }
    t.bypass += e.bypass;
  }
  return t;
}

const uint32_t kNever = 0xFFFFFFFF;

}  // namespace

TEST(short_press_fires_on_release_only) {
  FootswitchLogic l;
  int fired_while_down = 0;
  for (uint32_t ms = 100; ms < 200; ++ms)
    fired_while_down += l.Update(true, false, ms).any();
  CHECK(fired_while_down == 0);
  int fired_after = 0;
  for (uint32_t ms = 200; ms < 300; ++ms)
    fired_after += l.Update(false, false, ms).fs[0] == FootswitchEvents::kShort;
  CHECK(fired_after == 1);
}

TEST(short_press_each_switch) {
  Totals f1 = Run({100, 300}, {kNever, kNever});
  CHECK(f1.shorts[0] == 1 && f1.shorts[1] == 0 && f1.holds[0] == 0);
  Totals f2 = Run({kNever, kNever}, {100, 300});
  CHECK(f2.shorts[1] == 1 && f2.shorts[0] == 0 && f2.holds[1] == 0);
}

TEST(hold_fires_at_500ms_and_release_does_nothing_more) {
  Totals t = Run({100, 1500}, {kNever, kNever});
  CHECK(t.holds[0] == 1);
  CHECK(t.shorts[0] == 0);
  CHECK(t.hold_time[0] >= 600 && t.hold_time[0] <= 602);  // 100 + 500
}

TEST(hold_threshold_boundary) {
  Totals just_short = Run({100, 590}, {kNever, kNever});  // 490 ms
  CHECK(just_short.shorts[0] == 1 && just_short.holds[0] == 0);
  Totals just_hold = Run({100, 620}, {kNever, kNever});  // 520 ms
  CHECK(just_hold.holds[0] == 1 && just_hold.shorts[0] == 0);
}

TEST(bypass_gesture_fires_once_on_second_release) {
  // both within 50 ms, released after 300 ms
  FootswitchLogic l;
  int bypass_while_down = 0;
  Totals t;
  const uint32_t d0 = 100, d1 = 150, u0 = 400, u1 = 430;
  for (uint32_t ms = 0; ms < 1500; ++ms) {
    const bool a = ms >= d0 && ms < u0;
    const bool b = ms >= d1 && ms < u1;
    const FootswitchEvents e = l.Update(a, b, ms);
    if (e.bypass) {
      ++t.bypass;
      CHECK(ms >= u1 && ms <= u1 + 20);  // at the release of the second switch
    }
    if (a || b) bypass_while_down += e.bypass && ms < u1;
    t.shorts[0] += e.fs[0] == FootswitchEvents::kShort;
    t.shorts[1] += e.fs[1] == FootswitchEvents::kShort;
    t.holds[0] += e.fs[0] == FootswitchEvents::kHold;
    t.holds[1] += e.fs[1] == FootswitchEvents::kHold;
  }
  CHECK(t.bypass == 1);
  CHECK(bypass_while_down == 0);
  CHECK(t.shorts[0] == 0 && t.shorts[1] == 0);
  CHECK(t.holds[0] == 0 && t.holds[1] == 0);
}

TEST(bypass_gesture_works_in_either_order) {
  Totals t = Run({150, 400}, {100, 430});
  CHECK(t.bypass == 1);
  CHECK(t.shorts[0] == 0 && t.shorts[1] == 0);
}

TEST(two_presses_too_far_apart_are_no_bypass_and_no_singles) {
  Totals t = Run({100, 400}, {250, 450});  // 150 ms apart
  CHECK(t.bypass == 0);
  CHECK(t.shorts[0] == 0 && t.shorts[1] == 0);
  CHECK(t.holds[0] == 0 && t.holds[1] == 0);
}

TEST(bypass_release_window_800ms) {
  Totals ok = Run({100, 880}, {120, 890});   // released 790 ms after first press
  CHECK(ok.bypass == 1);
  Totals late = Run({100, 910}, {120, 920});  // 820 ms
  CHECK(late.bypass == 0);
  CHECK(late.shorts[0] == 0 && late.shorts[1] == 0);
}

TEST(holding_both_never_fires_single_functions_or_bypass) {
  Totals t = Run({100, 3000}, {120, 3000}, 3500);  // like the DFU gesture
  CHECK(t.bypass == 0);
  CHECK(t.shorts[0] == 0 && t.shorts[1] == 0);
  CHECK(t.holds[0] == 0 && t.holds[1] == 0);
}

TEST(second_switch_during_hold_does_not_fire_a_short) {
  // FS1 held (page opened at 600 ms), FS2 tapped at 900..1000
  Totals t = Run({100, 1500}, {900, 1000});
  CHECK(t.holds[0] == 1);
  CHECK(t.shorts[1] == 0);
  CHECK(t.bypass == 0);
}

TEST(contact_bounce_is_filtered) {
  FootswitchLogic l;
  Totals t;
  // press with bounce: 1,0,1,0,1 over 5 ms, then down for 200 ms, release with bounce
  for (uint32_t ms = 0; ms < 2000; ++ms) {
    bool down = false;
    if (ms >= 100 && ms < 105) down = (ms % 2 == 0);
    else if (ms >= 105 && ms < 300) down = true;
    else if (ms >= 300 && ms < 304) down = (ms % 2 == 0);
    const FootswitchEvents e = l.Update(down, false, ms);
    t.shorts[0] += e.fs[0] == FootswitchEvents::kShort;
    t.holds[0] += e.fs[0] == FootswitchEvents::kHold;
  }
  CHECK(t.shorts[0] == 1);
  CHECK(t.holds[0] == 0);
}

TEST(sequence_of_independent_presses) {
  FootswitchLogic l;
  Totals t;
  for (uint32_t ms = 0; ms < 3000; ++ms) {
    const bool a = (ms >= 100 && ms < 200) || (ms >= 1000 && ms < 1100);
    const bool b = ms >= 500 && ms < 600;
    const FootswitchEvents e = l.Update(a, b, ms);
    t.shorts[0] += e.fs[0] == FootswitchEvents::kShort;
    t.shorts[1] += e.fs[1] == FootswitchEvents::kShort;
    t.bypass += e.bypass;
  }
  CHECK(t.shorts[0] == 2);
  CHECK(t.shorts[1] == 1);
  CHECK(t.bypass == 0);
}
