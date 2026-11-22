#pragma once
// Storage of the settings in the QSPI flash with wear leveling.
//
// NOR flash can only be erased in 4 KB sectors (limited to ~100,000 times per
// sector), but a slot can be written once after an erase. So instead of
// erasing at every save, the settings are APPENDED as records into a ring of
// sectors: a sector is erased only when the ring comes around to it again.
// With 8 sectors of 32 slots each, one erase serves 32 saves and the wear is
// spread over all sectors (about 25 million saves in total).
//
// Safe against power loss: the newest valid record is kept until a newer one
// is complete (checksum), and an erase only hits a sector that does not hold
// the newest record.
//
// Hardware-free: the flash is a template parameter (a RAM model in the tests,
// the QSPI chip in the firmware). `Flash` must provide
//   const uint8_t* Data();                                   // memory-mapped read access to the region
//   bool EraseSector(uint32_t sector);                       // sector 0..kSectors-1
//   bool Write(uint32_t offset, const uint8_t* p, uint32_t n);  // only into erased (0xFF) bytes
#include <cstddef>
#include <cstdint>
#include <cstring>

#include "ui/settings.h"

namespace bm {

constexpr uint32_t kStoreSectorBytes = 4096;
constexpr uint32_t kStoreSectors = 8;
constexpr uint32_t kStoreSlotBytes = 128;
constexpr uint32_t kStoreSlotsPerSector = kStoreSectorBytes / kStoreSlotBytes;
constexpr uint32_t kStoreSlots = kStoreSectors * kStoreSlotsPerSector;
constexpr uint32_t kStoreBytes = kStoreSectors * kStoreSectorBytes;

// One slot: a sequence number (rising with every save) and the settings.
// The layout of the first 108 bytes equals the old PersistentStorage record
// (state word + settings), so data written by earlier firmware is read as a
// record with a small sequence number.
struct StoreRecord {
  uint32_t seq;
  Settings settings;
};
static_assert(sizeof(StoreRecord) <= kStoreSlotBytes, "record must fit in a slot");

template <class Flash>
class SettingsStore {
 public:
  explicit SettingsStore(Flash* flash) : flash_(flash) {}

  // Finds the newest valid record. Returns false (and leaves `out`) if there is none.
  bool Load(Settings* out) {
    const uint8_t* base = flash_->Data();
    newest_ = -1;
    next_seq_ = 1;
    uint32_t best_seq = 0;
    for (uint32_t i = 0; i < kStoreSlots; ++i) {
      StoreRecord r;
      std::memcpy(&r, base + i * kStoreSlotBytes, sizeof r);
      if (r.seq == 0 || r.seq == 0xFFFFFFFFu || !SettingsValid(r.settings)) continue;
      if (newest_ < 0 || r.seq > best_seq) {
        best_seq = r.seq;
        newest_ = static_cast<int32_t>(i);
        newest_settings_ = r.settings;
      }
    }
    loaded_ = true;
    if (newest_ < 0) return false;
    next_seq_ = best_seq + 1;
    *out = newest_settings_;
    return true;
  }

  // Appends the settings as the newest record. Returns false if the flash failed.
  bool Save(const Settings& s) {
    if (!loaded_) {
      Settings ignored;
      Load(&ignored);
    }
    const uint8_t* base = flash_->Data();
    uint32_t target = newest_ < 0 ? 0 : (static_cast<uint32_t>(newest_) + 1) % kStoreSlots;
    const uint32_t newest_sector = newest_ < 0 ? kStoreSectors : static_cast<uint32_t>(newest_) / kStoreSlotsPerSector;
    // Skip slots that are not clean (e.g. half-written by a power loss).
    for (uint32_t tries = 0; tries < kStoreSlots; ++tries) {
      const uint32_t sector = target / kStoreSlotsPerSector;
      if (SlotErased(base, target)) break;
      if (sector == newest_sector) {
        // Never erase the sector that holds the newest record: move on to the next one.
        target = ((sector + 1) % kStoreSectors) * kStoreSlotsPerSector;
        continue;
      }
      if (!flash_->EraseSector(sector)) return false;
      base = flash_->Data();
      if (!SlotErased(base, target)) return false;
      break;
    }
    if (!SlotErased(base, target)) return false;
    // Unused bytes stay 0xFF (erased state), so only the record is programmed.
    uint8_t buf[kStoreSlotBytes];
    std::memset(buf, 0xFF, sizeof buf);
    const uint32_t seq = next_seq_;
    std::memcpy(buf + offsetof(StoreRecord, seq), &seq, sizeof seq);
    std::memcpy(buf + offsetof(StoreRecord, settings), &s, sizeof s);
    if (!flash_->Write(target * kStoreSlotBytes, buf, kStoreSlotBytes)) return false;
    newest_ = static_cast<int32_t>(target);
    newest_settings_ = s;
    ++next_seq_;
    return true;
  }

  // Erases everything (factory state).
  bool EraseAll() {
    for (uint32_t s = 0; s < kStoreSectors; ++s) {
      if (!flash_->EraseSector(s)) return false;
    }
    loaded_ = false;
    newest_ = -1;
    return true;
  }

  int32_t newest_slot() const { return newest_; }
  uint32_t next_sequence() const { return next_seq_; }

 private:
  static bool SlotErased(const uint8_t* base, uint32_t slot) {
    const uint8_t* p = base + slot * kStoreSlotBytes;
    for (uint32_t i = 0; i < kStoreSlotBytes; ++i) {
      if (p[i] != 0xFF) return false;
    }
    return true;
  }

  Flash* flash_;
  bool loaded_ = false;
  int32_t newest_ = -1;
  uint32_t next_seq_ = 1;
  Settings newest_settings_;
};

}  // namespace bm
