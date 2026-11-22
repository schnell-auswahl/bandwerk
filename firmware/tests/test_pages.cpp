#include "test_framework.h"
#include "ui/pages.h"

using namespace bm;

TEST(defaults_match_spec) {
  Params p;
  CHECK_NEAR(p.master, 0.5, 1e-9);
  CHECK_NEAR(p.crossover, 0.5, 1e-9);
  CHECK_NEAR(p.comp[0].dry_wet, 0.6, 1e-6);  // high 60 %
  CHECK_NEAR(p.comp[1].dry_wet, 1.0, 1e-6);  // low 100 %
  CHECK_NEAR(p.loop_mix, 1.0, 1e-6);         // 100 % = serial
  CHECK_NEAR(p.loop_trim, 0.5, 1e-6);        // 12 o'clock = measured latency, no offset
  CHECK(p.loop_latency == 0.0f);             // not measured yet
  CHECK(!p.octave_on);
  CHECK(!p.drive_on);
}

TEST(comp_defaults_follow_provisional_mapping) {
  Params p;
  // threshold: linear dB -40..-6 ; -18 dB and -24 dB
  CHECK_NEAR(-40.0 + p.comp[0].threshold * 34.0, -18.0, 0.1);
  CHECK_NEAR(-40.0 + p.comp[1].threshold * 34.0, -24.0, 0.1);
}

TEST(slot_targets_single_band) {
  Params p;
  SlotTargets t = GetSlotTargets(p, Page::kComp, BandSel::kHigh, 0);
  CHECK(t.count == 1);
  CHECK(t.value[0] == &p.comp[0].ratio);
  t = GetSlotTargets(p, Page::kComp, BandSel::kLow, 3);
  CHECK(t.value[0] == &p.comp[1].threshold);
}

TEST(slot_targets_both_bands_have_two) {
  Params p;
  SlotTargets t = GetSlotTargets(p, Page::kComp, BandSel::kBoth, 2);
  CHECK(t.count == 2);
  CHECK(t.value[0] == &p.comp[0].release);
  CHECK(t.value[1] == &p.comp[1].release);
  p.comp[0].release = 0.2f;
  p.comp[1].release = 0.6f;
  CHECK_NEAR(SlotPickupValue(p, Page::kComp, BandSel::kBoth, 2), 0.4, 1e-6);
}

TEST(slot_mapping_other_pages) {
  Params p;
  CHECK(GetSlotTargets(p, Page::kLoop, BandSel::kBoth, 0).value[0] == &p.loop_send);
  CHECK(GetSlotTargets(p, Page::kLoop, BandSel::kBoth, 1).value[0] == &p.loop_mix);
  CHECK(GetSlotTargets(p, Page::kLoop, BandSel::kBoth, 2).value[0] == &p.loop_return);
  CHECK(GetSlotTargets(p, Page::kLoop, BandSel::kBoth, 3).value[0] == &p.loop_trim);
  CHECK(GetSlotTargets(p, Page::kOctave, BandSel::kBoth, 0).value[0] == &p.oct_level_down);
  CHECK(GetSlotTargets(p, Page::kOctave, BandSel::kBoth, 1).value[0] == &p.oct_dry_wet);
  CHECK(GetSlotTargets(p, Page::kOctave, BandSel::kBoth, 2).value[0] == &p.oct_level_up);
  CHECK(GetSlotTargets(p, Page::kOctave, BandSel::kBoth, 3).value[0] == &p.oct_sub_tone);
  CHECK(GetSlotTargets(p, Page::kDrive, BandSel::kBoth, 0).value[0] == &p.drive_gain);
  CHECK(GetSlotTargets(p, Page::kDrive, BandSel::kBoth, 1).value[0] == &p.drive_band_mix);
  CHECK(GetSlotTargets(p, Page::kDrive, BandSel::kBoth, 2).value[0] == &p.drive_level);
  CHECK(GetSlotTargets(p, Page::kDrive, BandSel::kBoth, 3).value[0] == &p.drive_tone);
}
