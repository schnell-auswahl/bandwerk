#include "test_framework.h"
#include "ui/toggle_settle.h"

using bm::TogglePos;
using bm::ToggleSettle;

namespace {
struct Counts {
  int raw = 0, eff = 0;
};
// Feeds `pos` every ms from t0 (inclusive) to t1 (exclusive).
void Hold(ToggleSettle& t, TogglePos pos, uint32_t t0, uint32_t t1, Counts* c) {
  for (uint32_t ms = t0; ms < t1; ++ms) {
    const ToggleSettle::Result r = t.Update(pos, ms);
    c->raw += r.raw_changed;
    c->eff += r.effective_changed;
  }
}
}  // namespace

TEST(init_gives_no_events) {
  ToggleSettle t;
  t.Init(TogglePos::kUp);
  Counts c;
  Hold(t, TogglePos::kUp, 0, 1000, &c);
  CHECK(c.raw == 0 && c.eff == 0);
  CHECK(t.effective() == TogglePos::kUp);
}

TEST(move_changes_page_fast_and_audio_after_300ms) {
  ToggleSettle t;
  t.Init(TogglePos::kMiddle);
  Counts c;
  Hold(t, TogglePos::kMiddle, 0, 100, &c);
  Hold(t, TogglePos::kDown, 100, 130, &c);
  CHECK(c.raw == 1);                       // page change within ~20 ms
  CHECK(c.eff == 0);
  CHECK(t.effective() == TogglePos::kMiddle);
  Hold(t, TogglePos::kDown, 130, 399, &c);
  CHECK(c.eff == 0);                       // 299 ms after the move
  Hold(t, TogglePos::kDown, 399, 410, &c);
  CHECK(c.eff == 1);
  CHECK(t.effective() == TogglePos::kDown);
}

TEST(quick_there_and_back_only_changes_page) {
  ToggleSettle t;
  t.Init(TogglePos::kMiddle);
  Counts c;
  Hold(t, TogglePos::kMiddle, 0, 100, &c);
  Hold(t, TogglePos::kUp, 100, 200, &c);      // 100 ms up
  Hold(t, TogglePos::kMiddle, 200, 1000, &c);
  CHECK(c.raw == 2);  // page called up on the way up and on the way back
  CHECK(c.eff == 0);  // audio meaning never changed
  CHECK(t.effective() == TogglePos::kMiddle);
}

TEST(passing_through_middle_is_filtered) {
  ToggleSettle t;
  t.Init(TogglePos::kUp);
  Counts c;
  Hold(t, TogglePos::kUp, 0, 100, &c);
  Hold(t, TogglePos::kMiddle, 100, 105, &c);  // 5 ms contact transition
  Hold(t, TogglePos::kDown, 105, 600, &c);
  CHECK(c.raw == 1);
  CHECK(c.eff == 1);
  CHECK(t.effective() == TogglePos::kDown);
}

TEST(bounce_on_move_is_filtered) {
  ToggleSettle t;
  t.Init(TogglePos::kUp);
  Counts c;
  Hold(t, TogglePos::kUp, 0, 100, &c);
  // bounce between up and middle for 8 ms, then settles on middle
  for (uint32_t ms = 100; ms < 108; ++ms)
    t.Update((ms % 2) ? TogglePos::kUp : TogglePos::kMiddle, ms);
  Hold(t, TogglePos::kMiddle, 108, 700, &c);
  CHECK(c.raw == 1);
  CHECK(t.effective() == TogglePos::kMiddle);
}
