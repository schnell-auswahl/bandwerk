#include <cmath>

#include "test_framework.h"
#include "ui/settings.h"

using namespace bm;

namespace {
Params Tweaked() {
  Params p;
  for (int i = 0; i < kNumParams; ++i) *ParamPtr(p, i) = (i + 1) / 25.0f;
  p.octave_on = true;
  p.drive_on = false;
  return p;
}
}  // namespace

TEST(settings_roundtrip_keeps_every_value) {
  const Params a = Tweaked();
  Params b;
  CHECK(UnpackSettings(PackSettings(a), &b));
  Params a2 = a;
  for (int i = 0; i < kNumParams; ++i) CHECK(*ParamPtr(a2, i) == *ParamPtr(b, i));
  CHECK(b.octave_on == true && b.drive_on == false);
}

TEST(settings_pack_is_deterministic) {
  CHECK(PackSettings(Tweaked()) == PackSettings(Tweaked()));
  CHECK(PackSettings(Tweaked()) != PackSettings(Params()));
}

TEST(settings_reject_wrong_magic_version_checksum) {
  Params out;
  Settings s = PackSettings(Tweaked());
  s.magic ^= 1;
  s.checksum = SettingsChecksum(s);
  CHECK(!UnpackSettings(s, &out));
  s = PackSettings(Tweaked());
  s.version = kSettingsVersion + 1;
  s.checksum = SettingsChecksum(s);
  CHECK(!UnpackSettings(s, &out));
  s = PackSettings(Tweaked());
  s.value[3] += 0.01f;  // bit rot: checksum no longer fits
  CHECK(!UnpackSettings(s, &out));
}

TEST(settings_reject_out_of_range_and_nan_even_with_good_checksum) {
  Params out;
  const float bad[] = {1.5f, -0.1f, NAN, INFINITY};
  for (float v : bad) {
    Settings s = PackSettings(Tweaked());
    s.value[5] = v;
    s.checksum = SettingsChecksum(s);
    CHECK(!SettingsValid(s));
    CHECK(!UnpackSettings(s, &out));
  }
  Settings s = PackSettings(Tweaked());
  s.drive_on = 2;
  s.checksum = SettingsChecksum(s);
  CHECK(!SettingsValid(s));
}

TEST(settings_erased_flash_is_invalid_and_leaves_defaults) {
  Settings s;
  std::memset(static_cast<void*>(&s), 0xFF, sizeof s);  // erased QSPI reads as 0xFF (raw bytes on purpose)
  Params out = Tweaked();
  CHECK(!UnpackSettings(s, &out));
  Params same = Tweaked();
  CHECK(out.master == same.master && out.octave_on == same.octave_on);
  std::memset(static_cast<void*>(&s), 0, sizeof s);
  CHECK(!SettingsValid(s));
}

TEST(settings_every_single_bit_flip_is_caught) {
  const Settings good = PackSettings(Tweaked());
  const size_t n = offsetof(Settings, checksum);
  int accepted = 0;
  for (size_t byte = 0; byte < n; ++byte) {
    for (int bit = 0; bit < 8; ++bit) {
      Settings s = good;
      reinterpret_cast<uint8_t*>(&s)[byte] ^= static_cast<uint8_t>(1u << bit);
      if (SettingsValid(s)) ++accepted;
    }
  }
  CHECK(accepted == 0);
}

TEST(scheduler_saves_only_after_idle_and_only_if_changed) {
  const Settings base = PackSettings(Params());
  SaveScheduler sch;
  sch.Init(base, 0);
  for (uint32_t t = 0; t < 20000; t += 10) CHECK(!sch.Update(base, t));  // nothing changed
  Params p;
  p.master = 0.8f;
  const Settings changed = PackSettings(p);
  CHECK(!sch.Update(changed, 20000));
  CHECK(!sch.Update(changed, 22999));
  CHECK(sch.Update(changed, 23000));
  CHECK(!sch.Update(changed, 23010));  // once
  CHECK(sch.saves() == 1);
}

TEST(scheduler_waits_while_knob_keeps_moving) {
  SaveScheduler sch;
  sch.Init(PackSettings(Params()), 0);
  Params p;
  int saved = 0;
  for (uint32_t t = 0; t < 10000; t += 10) {  // a new value every 100 ms
    if (t % 100 == 0) p.master = (t / 100 + 1) / 300.0f;
    saved += sch.Update(PackSettings(p), t);
  }
  CHECK(saved == 0);
  CHECK(sch.Update(PackSettings(p), 10000 + 3000));
}

TEST(scheduler_change_and_revert_within_idle_writes_nothing) {
  const Settings base = PackSettings(Params());
  SaveScheduler sch;
  sch.Init(base, 0);
  Params p;
  p.master = 0.9f;
  CHECK(!sch.Update(PackSettings(p), 1000));
  CHECK(!sch.Update(base, 2000));  // back to the stored value
  for (uint32_t t = 2000; t < 10000; t += 10) CHECK(!sch.Update(base, t));
  CHECK(sch.saves() == 0);
}

TEST(scheduler_handles_clock_wraparound) {
  const uint32_t t0 = 0xFFFFFF00u;
  SaveScheduler sch;
  sch.Init(PackSettings(Params()), t0);
  Params p;
  p.drive_on = true;
  CHECK(!sch.Update(PackSettings(p), t0 + 100));
  CHECK(!sch.Update(PackSettings(p), t0 + 2000));
  CHECK(sch.Update(PackSettings(p), t0 + 100 + 3000));
}

TEST(scheduler_first_change_after_invalid_flash_is_saved) {
  // Flash empty -> caller starts with defaults but tells the scheduler the
  // stored data is "nothing" (all zero), so even unchanged defaults get written.
  Settings nothing;
  SaveScheduler sch;
  sch.Init(nothing, 0);
  const Settings defaults = PackSettings(Params());
  CHECK(!sch.Update(defaults, 100));
  CHECK(sch.Update(defaults, 3100));
}

TEST(settings_store_the_measured_loop_latency) {
  Params p;
  p.loop_latency = 170.9f;
  Params out;
  CHECK(UnpackSettings(PackSettings(p), &out));
  CHECK(std::fabs(out.loop_latency - 170.9f) < 1.0f / 32.0f);
}

TEST(settings_version_1_is_read_and_k6_becomes_the_centered_fine_trim) {
  Params p;
  p.master = 0.7f;
  p.loop_trim = 0.0f;  // in version 1 this meant "0 ms extra"
  Settings s = PackSettings(p);
  s.version = 1;
  s.loop_latency_q5 = 0;  // the bytes were reserved and zero in version 1
  s.checksum = SettingsChecksum(s);
  Params out;
  CHECK(UnpackSettings(s, &out));
  CHECK(out.master == 0.7f);
  CHECK(out.loop_trim == 0.5f);     // 12 o'clock = no offset from the measured latency
  CHECK(out.loop_latency == 0.0f);  // not measured yet
}
