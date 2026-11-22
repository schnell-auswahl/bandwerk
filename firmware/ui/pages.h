// Pages, parameter store and knob-slot mapping.
// Hardware-free. All parameters are stored normalized (0..1); the mapping to
// physical ranges happens where a parameter is applied (DSP code).
#pragma once

#include <cstdint>

namespace bm {

enum class Page : uint8_t { kComp = 0, kLoop, kOctave, kDrive };

// S1 selects which compressor band the page-COMP knobs edit.
enum class BandSel : uint8_t { kHigh = 0, kBoth, kLow };
// S2 selects the FX loop mode.
enum class LoopMode : uint8_t { kBridge = 0, kLoop, kLoopInverted };
// S3 selects the drive type.
enum class DriveType : uint8_t { kOverdrive = 0, kDistortion, kFuzz };

// Page-dependent knobs: K2, K4, K5, K6 (K1 = master and K3 = crossover are
// global and always live).
constexpr int kNumSlots = 4;
constexpr int kSlotKnob[kNumSlots] = {1, 3, 4, 5};  // index into knob[0..5]

struct CompParams {
  float threshold;  // K6
  float ratio;      // K2
  float release;    // K5
  float dry_wet;    // K4
};

struct Params {
  // Global
  float master = 0.5f;     // K1, 12 o'clock = 0 dB
  float crossover = 0.5f;  // K3, 12 o'clock = 250 Hz

  // Page COMP: [0] = high band, [1] = low band.
  CompParams comp[2] = {
      // Normalized from the factory defaults; the mapping to dB, ratio
      // and ms is in dsp/mapping.h (final since M3: linear dB, log ratio/release).
      {0.647f, 0.414f, 0.463f, 0.6f},  // high: -18 dB, 3:1, 80 ms, 60 %
      {0.471f, 0.431f, 0.528f, 1.0f},  // low:  -24 dB, 8:1, 150 ms, 100 %
  };

  // Page LOOP
  float loop_send = 0.5f;    // K2
  float loop_mix = 1.0f;     // K4
  float loop_return = 0.5f;  // K5
  float loop_trim = 0.5f;    // K6, fine trim +-1 ms, 12 o'clock = measured latency

  // Page OCTAVE
  float oct_level_down = 0.5f;  // K2, 100 %
  float oct_dry_wet = 0.5f;     // K4, both full
  float oct_level_up = 0.5f;    // K5, 100 %
  float oct_sub_tone = 0.5f;    // K6, ~200 Hz

  // Page DRIVE
  float drive_gain = 0.5f;      // K2
  float drive_band_mix = 0.5f;  // K4
  float drive_level = 0.5f;     // K5
  float drive_tone = 0.5f;      // K6

  // FX loop latency measured automatically (send -> return, samples). Not a
  // knob value; 0 = never measured (the chain then uses kLoopRoundTripSamples).
  float loop_latency = 0.0f;

  // Footswitch states (persisted in M7)
  bool octave_on = false;
  bool drive_on = false;
};

// Pointers to the stored value(s) behind one knob slot. Only page COMP with
// both bands selected has two targets.
struct SlotTargets {
  float* value[2] = {nullptr, nullptr};
  int count = 0;
};

inline SlotTargets GetSlotTargets(Params& p, Page page, BandSel band,
                                  int slot) {
  SlotTargets t;
  auto one = [&t](float* v) {
    t.value[0] = v;
    t.count = 1;
  };
  switch (page) {
    case Page::kComp: {
      // slot order: K2 ratio, K4 dry/wet, K5 release, K6 threshold
      auto pick = [slot](CompParams& c) -> float* {
        switch (slot) {
          case 0: return &c.ratio;
          case 1: return &c.dry_wet;
          case 2: return &c.release;
          default: return &c.threshold;
        }
      };
      if (band == BandSel::kBoth) {
        t.value[0] = pick(p.comp[0]);
        t.value[1] = pick(p.comp[1]);
        t.count = 2;
      } else {
        one(pick(p.comp[band == BandSel::kHigh ? 0 : 1]));
      }
      break;
    }
    case Page::kLoop:
      one(slot == 0 ? &p.loop_send
                    : slot == 1 ? &p.loop_mix
                                : slot == 2 ? &p.loop_return : &p.loop_trim);
      break;
    case Page::kOctave:
      one(slot == 0 ? &p.oct_level_down
                    : slot == 1 ? &p.oct_dry_wet
                                : slot == 2 ? &p.oct_level_up
                                            : &p.oct_sub_tone);
      break;
    case Page::kDrive:
      one(slot == 0 ? &p.drive_gain
                    : slot == 1 ? &p.drive_band_mix
                                : slot == 2 ? &p.drive_level : &p.drive_tone);
      break;
  }
  return t;
}

// Value the knob has to pick up. For page COMP / both bands this is the mean
// of the two stored values.
inline float SlotPickupValue(Params& p, Page page, BandSel band, int slot) {
  const SlotTargets t = GetSlotTargets(p, page, band, slot);
  if (t.count == 2) return 0.5f * (*t.value[0] + *t.value[1]);
  return *t.value[0];
}

// All 22 stored parameters in the fixed order of the telemetry line "pm" and of
// the remote "set" command (see ParamName).
constexpr int kNumParams = 22;

inline float* ParamPtr(Params& p, int idx) {
  switch (idx) {
    case 0: return &p.master;
    case 1: return &p.crossover;
    case 2: return &p.comp[0].threshold;
    case 3: return &p.comp[0].ratio;
    case 4: return &p.comp[0].release;
    case 5: return &p.comp[0].dry_wet;
    case 6: return &p.comp[1].threshold;
    case 7: return &p.comp[1].ratio;
    case 8: return &p.comp[1].release;
    case 9: return &p.comp[1].dry_wet;
    case 10: return &p.loop_send;
    case 11: return &p.loop_mix;
    case 12: return &p.loop_return;
    case 13: return &p.loop_trim;
    case 14: return &p.oct_level_down;
    case 15: return &p.oct_dry_wet;
    case 16: return &p.oct_level_up;
    case 17: return &p.oct_sub_tone;
    case 18: return &p.drive_gain;
    case 19: return &p.drive_band_mix;
    case 20: return &p.drive_level;
    case 21: return &p.drive_tone;
    default: return nullptr;
  }
}

inline const char* ParamName(int idx) {
  static const char* const kNames[kNumParams] = {
      "master",  "xover",   "ch_thr",  "ch_ratio", "ch_rel",  "ch_dw",
      "cl_thr",  "cl_ratio", "cl_rel", "cl_dw",    "lp_send", "lp_mix",
      "lp_ret",  "lp_trim", "oc_ld",   "oc_dw",    "oc_lu",   "oc_st",
      "dv_gain", "dv_mix",  "dv_level", "dv_tone"};
  return (idx >= 0 && idx < kNumParams) ? kNames[idx] : "?";
}

// Index of a parameter by name, or -1.
inline int ParamIndex(const char* name) {
  for (int i = 0; i < kNumParams; ++i) {
    const char* a = ParamName(i);
    const char* b = name;
    while (*a != '\0' && *a == *b) { ++a; ++b; }
    if (*a == '\0' && *b == '\0') return i;
  }
  return -1;
}

inline const char* PageName(Page p) {
  switch (p) {
    case Page::kComp: return "COMP";
    case Page::kLoop: return "LOOP";
    case Page::kOctave: return "OCTAVE";
    default: return "DRIVE";
  }
}
// Short names of the four knob slots (K2, K4, K5, K6) on each page.
inline const char* SlotName(Page page, int slot) {
  static const char* const kNames[4][kNumSlots] = {
      {"ratio", "drywet", "release", "thresh"},
      {"send", "mix", "return", "trim"},
      {"lvl-1", "drywet", "lvl+1", "subtone"},
      {"gain", "bandmix", "level", "tone"},
  };
  return kNames[static_cast<int>(page)][slot];
}
inline const char* BandName(BandSel b) {
  return b == BandSel::kHigh ? "HIGH" : (b == BandSel::kBoth ? "BOTH" : "LOW");
}
inline const char* LoopModeName(LoopMode m) {
  return m == LoopMode::kBridge ? "BRIDGE"
                                : (m == LoopMode::kLoop ? "LOOP" : "LOOP-PHASE");
}
inline const char* DriveTypeName(DriveType d) {
  return d == DriveType::kOverdrive
             ? "OD"
             : (d == DriveType::kDistortion ? "DIST" : "FUZZ");
}

}  // namespace bm
