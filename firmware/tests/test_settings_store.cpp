#include <cstdlib>
#include <vector>

#include "test_framework.h"
#include "ui/settings_store.h"

using namespace bm;

namespace {

// RAM model of the NOR flash: erase sets 0xFF, a write may only clear bits.
struct SimFlash {
  std::vector<uint8_t> mem = std::vector<uint8_t>(kStoreBytes, 0xFF);
  uint32_t erases[kStoreSectors] = {};
  int illegal_writes = 0;
  int fail_erase_after = -1;  // >= 0: erase fails after this many more erases

  const uint8_t* Data() { return mem.data(); }
  bool EraseSector(uint32_t s) {
    if (fail_erase_after == 0) return false;
    if (fail_erase_after > 0) --fail_erase_after;
    std::memset(&mem[s * kStoreSectorBytes], 0xFF, kStoreSectorBytes);
    ++erases[s];
    return true;
  }
  bool Write(uint32_t offset, const uint8_t* p, uint32_t n) {
    for (uint32_t i = 0; i < n; ++i) {
      if ((mem[offset + i] & p[i]) != p[i]) ++illegal_writes;  // would need a 0 -> 1 change
      mem[offset + i] &= p[i];
    }
    return true;
  }
};

Settings Make(int n) {
  Params p;
  p.master = (n % 1000) / 1000.0f;
  p.comp[0].threshold = ((n / 7) % 1000) / 1000.0f;
  p.octave_on = n % 2;
  p.drive_on = (n / 2) % 2;
  return PackSettings(p);
}

bool Same(const Settings& a, const Settings& b) { return a == b; }
}  // namespace

TEST(store_empty_flash_has_nothing) {
  SimFlash f;
  SettingsStore<SimFlash> st(&f);
  Settings s;
  CHECK(!st.Load(&s));
}

TEST(store_save_then_load_in_a_new_object_gives_the_newest) {
  SimFlash f;
  {
    SettingsStore<SimFlash> st(&f);
    for (int i = 1; i <= 5; ++i) CHECK(st.Save(Make(i)));
  }
  SettingsStore<SimFlash> st2(&f);
  Settings s;
  CHECK(st2.Load(&s));
  CHECK(Same(s, Make(5)));
  CHECK(f.illegal_writes == 0);
}

TEST(store_spreads_wear_evenly_and_erases_once_per_32_saves) {
  SimFlash f;
  SettingsStore<SimFlash> st(&f);
  const int kSaves = 20000;
  for (int i = 1; i <= kSaves; ++i) {
    CHECK(st.Save(Make(i)));
    if (i % 997 == 0) {  // power cycle now and then: a fresh object must continue the ring
      SettingsStore<SimFlash> again(&f);
      Settings s;
      CHECK(again.Load(&s) && Same(s, Make(i)));
    }
  }
  Settings s;
  SettingsStore<SimFlash> fresh(&f);
  CHECK(fresh.Load(&s) && Same(s, Make(kSaves)));
  uint32_t total = 0, lo = 1u << 30, hi = 0;
  for (uint32_t e : f.erases) {
    total += e;
    lo = e < lo ? e : lo;
    hi = e > hi ? e : hi;
  }
  std::printf("    %d saves: %u erases in total, per sector %u..%u\n", kSaves, total, lo, hi);
  CHECK(total <= kSaves / kStoreSlotsPerSector + 2);
  CHECK(hi - lo <= 1);
  CHECK(f.illegal_writes == 0);
}

TEST(store_power_loss_during_a_write_keeps_the_previous_settings) {
  SimFlash f;
  SettingsStore<SimFlash> st(&f);
  for (int i = 1; i <= 3; ++i) CHECK(st.Save(Make(i)));
  // The next save is cut off: only part of the record reaches the flash.
  const uint32_t slot = static_cast<uint32_t>(st.newest_slot()) + 1;
  StoreRecord r;
  std::memset(static_cast<void*>(&r), 0xFF, sizeof r);
  r.seq = st.next_sequence();
  r.settings = Make(4);
  std::memcpy(&f.mem[slot * kStoreSlotBytes], &r, 60);  // torn write
  SettingsStore<SimFlash> after(&f);
  Settings s;
  CHECK(after.Load(&s));
  CHECK(Same(s, Make(3)));
  // And saving again works and skips the damaged slot.
  CHECK(after.Save(Make(5)));
  SettingsStore<SimFlash> again(&f);
  CHECK(again.Load(&s) && Same(s, Make(5)));
  CHECK(f.illegal_writes == 0);
}

TEST(store_survives_a_failed_erase_with_the_old_record_intact) {
  SimFlash f;
  SettingsStore<SimFlash> st(&f);
  const int kFill = static_cast<int>(kStoreSlots);  // the ring is full once
  for (int i = 1; i <= kFill; ++i) CHECK(st.Save(Make(i)));
  f.fail_erase_after = 0;
  CHECK(!st.Save(Make(kFill + 1)));  // needs an erase, which fails
  SettingsStore<SimFlash> after(&f);
  Settings s;
  CHECK(after.Load(&s) && Same(s, Make(kFill)));
}

TEST(store_reads_a_record_written_by_the_old_persistent_storage_layout) {
  SimFlash f;
  struct Old { uint32_t state; Settings s; } old{2, Make(77)};  // State::USER
  std::memcpy(&f.mem[0], &old, sizeof old);
  SettingsStore<SimFlash> st(&f);
  Settings s;
  CHECK(st.Load(&s) && Same(s, Make(77)));
  CHECK(st.Save(Make(78)));
  SettingsStore<SimFlash> again(&f);
  CHECK(again.Load(&s) && Same(s, Make(78)));
}

TEST(store_random_garbage_never_crashes_and_only_valid_records_load) {
  std::srand(1234);
  for (int round = 0; round < 200; ++round) {
    SimFlash f;
    for (auto& b : f.mem) b = static_cast<uint8_t>(std::rand());
    SettingsStore<SimFlash> st(&f);
    Settings s;
    if (st.Load(&s)) CHECK(SettingsValid(s));
    CHECK(st.Save(Make(round)) || true);
    SettingsStore<SimFlash> again(&f);
    if (again.Load(&s)) CHECK(SettingsValid(s));
  }
}

TEST(store_erase_all_gives_the_factory_state) {
  SimFlash f;
  SettingsStore<SimFlash> st(&f);
  for (int i = 1; i <= 40; ++i) CHECK(st.Save(Make(i)));
  CHECK(st.EraseAll());
  Settings s;
  CHECK(!st.Load(&s));
  CHECK(st.Save(Make(1)));
  CHECK(st.Load(&s) && Same(s, Make(1)));
}
