#pragma once
// Persistent settings: a versioned, checksummed snapshot of the stored Params,
// plus the rule for when to write it. Hardware-free (the flash access itself is
// in bass_multiband.cpp), so everything here runs in the host tests.
#include <cstddef>
#include <cstdint>
#include <cstring>

#include "ui/pages.h"

namespace bm {

// Plain data, written to the QSPI chip as is. Bump kSettingsVersion whenever
// the layout or the meaning of a field changes: old data is then ignored and
// the defaults are used.
constexpr uint32_t kSettingsMagic = 0x424D5354;  // "BMST"
// Version 2: measured loop latency in the former reserved bytes,
// K6 became a fine trim around it (12 o'clock = 0). Version 1 is still read.
constexpr uint32_t kSettingsVersion = 2;

struct Settings {
  uint32_t magic = 0;
  uint32_t version = 0;
  float value[kNumParams] = {};  // normalized 0..1, order of ParamPtr()
  uint8_t octave_on = 0;
  uint8_t drive_on = 0;
  uint16_t loop_latency_q5 = 0;  // samples x 32, 0 = not measured
  uint32_t checksum = 0;  // over all bytes before this field

  // PersistentStorage only writes when the data differs.
  bool operator!=(const Settings& o) const {
    return std::memcmp(this, &o, sizeof(Settings)) != 0;
  }
  bool operator==(const Settings& o) const { return !(*this != o); }
};

// FNV-1a over the bytes up to (not including) the checksum field.
inline uint32_t SettingsChecksum(const Settings& s) {
  const uint8_t* p = reinterpret_cast<const uint8_t*>(&s);
  const size_t n = offsetof(Settings, checksum);
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < n; ++i) {
    h ^= p[i];
    h *= 16777619u;
  }
  return h;
}

inline Settings PackSettings(const Params& params) {
  Settings s;  // all fields initialized: padding-free and deterministic
  s.magic = kSettingsMagic;
  s.version = kSettingsVersion;
  Params copy = params;
  for (int i = 0; i < kNumParams; ++i) s.value[i] = *ParamPtr(copy, i);
  s.octave_on = params.octave_on ? 1 : 0;
  s.drive_on = params.drive_on ? 1 : 0;
  const float q = params.loop_latency * 32.0f + 0.5f;
  s.loop_latency_q5 = q <= 0.0f ? 0 : (q >= 65535.0f ? 65535 : static_cast<uint16_t>(q));
  s.checksum = SettingsChecksum(s);
  return s;
}

// Checks magic, version, checksum and that every value is a number in 0..1.
inline bool SettingsValid(const Settings& s) {
  if (s.magic != kSettingsMagic || (s.version != 1 && s.version != kSettingsVersion)) return false;
  if (s.checksum != SettingsChecksum(s)) return false;
  for (int i = 0; i < kNumParams; ++i) {
    const float v = s.value[i];
    if (!(v >= 0.0f && v <= 1.0f)) return false;  // also rejects NaN
  }
  return s.octave_on <= 1 && s.drive_on <= 1;
}

// Fills `out` from the settings. If they are not valid, `out` is left
// untouched and false is returned (caller keeps the defaults).
inline bool UnpackSettings(const Settings& s, Params* out) {
  if (!SettingsValid(s)) return false;
  Params p;
  for (int i = 0; i < kNumParams; ++i) *ParamPtr(p, i) = s.value[i];
  p.octave_on = s.octave_on != 0;
  p.drive_on = s.drive_on != 0;
  if (s.version == 1) {
    p.loop_trim = 0.5f;  // K6 meant 0..5 ms then; now 12 o'clock = measured latency
  } else {
    p.loop_latency = s.loop_latency_q5 / 32.0f;
  }
  *out = p;
  return true;
}

// Decides when to write. Flash wears out (and a write blocks for some ms), so
// we write only after the settings have stopped changing for kIdleMs, and only
// if they differ from what is stored. Call Update() from the main loop only.
class SaveScheduler {
 public:
  static constexpr uint32_t kIdleMs = 3000;

  // `stored` = what the flash holds now (or the starting values if it held
  // nothing valid: then the first real change gets saved too).
  void Init(const Settings& stored, uint32_t now_ms) {
    saved_ = stored;
    pending_ = stored;
    changed_ms_ = now_ms;
  }

  // Returns true when `current` should be written now; the caller writes it,
  // then the scheduler regards it as stored.
  bool Update(const Settings& current, uint32_t now_ms) {
    if (current != pending_) {
      pending_ = current;
      changed_ms_ = now_ms;
    }
    if (pending_ != saved_ && now_ms - changed_ms_ >= kIdleMs) {
      saved_ = pending_;
      ++saves_;
      return true;
    }
    return false;
  }

  uint32_t saves() const { return saves_; }

 private:
  Settings saved_;
  Settings pending_;
  uint32_t changed_ms_ = 0;
  uint32_t saves_ = 0;
};

}  // namespace bm
