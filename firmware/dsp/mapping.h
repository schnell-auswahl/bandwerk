// Mapping of normalized knob values (0..1) to physical values. Hardware-free.
#pragma once

#include <cmath>

#include "dsp/math_utils.h"

namespace bm {

// Crossover: two-part logarithmic, so that 12 o'clock is exactly 250 Hz.
inline float CrossoverHz(float k) {
  k = Clamp(k, 0.0f, 1.0f);
  return (k < 0.5f) ? 100.0f * powf(2.5f, 2.0f * k)
                    : 250.0f * powf(3.2f, 2.0f * k - 1.0f);
}

// Attenuation taper: 1 at t = 1, 0 at t = 0 (-inf dB), about -12 dB at
// t = 0.5. Used for the lower half of master and for the band mixer.
inline float AttenuationTaper(float t) {
  t = Clamp(t, 0.0f, 1.0f);
  return t * t;
}

// Master: -inf .. +6 dB, 12 o'clock = 0 dB.
inline float MasterGain(float k) {
  k = Clamp(k, 0.0f, 1.0f);
  if (k < 0.5f) return AttenuationTaper(k * 2.0f);
  return DbToLin(12.0f * (k - 0.5f));  // +6 dB at k = 1
}

// Band mix: 12 o'clock = both bands 0 dB. Left: high band fades out to -inf,
// low stays at 0 dB. Right: low band fades out, high stays at 0 dB.
inline void BandMixGains(float k, float* low, float* high) {
  k = Clamp(k, 0.0f, 1.0f);
  *low = k <= 0.5f ? 1.0f : AttenuationTaper((1.0f - k) * 2.0f);
  *high = k >= 0.5f ? 1.0f : AttenuationTaper(k * 2.0f);
}

// Compressor. Band 0 = high, 1 = low. Threshold is linear in dB; ratio and
// release are logarithmic over the band's own range.
inline float CompThresholdDb(float k) { return -40.0f + 34.0f * Clamp(k, 0.0f, 1.0f); }

inline float CompRatio(float k, int band) {
  const float lo = band == 0 ? 1.5f : 4.0f, hi = band == 0 ? 8.0f : 20.0f;
  return lo * powf(hi / lo, Clamp(k, 0.0f, 1.0f));
}

inline float CompReleaseMs(float k, int band) {
  const float lo = band == 0 ? 30.0f : 50.0f, hi = band == 0 ? 250.0f : 400.0f;
  return lo * powf(hi / lo, Clamp(k, 0.0f, 1.0f));
}

// Page OCTAVE. Levels: 0..200 % of the original, 12 o'clock = 100 %.
inline float OctLevel(float k) { return 2.0f * Clamp(k, 0.0f, 1.0f); }

// Dry/wet with a dual taper: at 12 o'clock direct signal and octaves are both
// 100 %. Left reduces only the octaves (left stop = direct only), right
// reduces only the direct signal (right stop = octaves only).
inline void OctDryWet(float k, float* dry, float* wet) {
  k = Clamp(k, 0.0f, 1.0f);
  *dry = k <= 0.5f ? 1.0f : AttenuationTaper((1.0f - k) * 2.0f);
  *wet = k >= 0.5f ? 1.0f : AttenuationTaper(k * 2.0f);
}

// Sub-Tone: cutoff of the low-pass behind the flip-flop, 80..500 Hz, log.
inline float OctSubToneHz(float k) { return 80.0f * powf(500.0f / 80.0f, Clamp(k, 0.0f, 1.0f)); }

// Page DRIVE. Pre-gain in dB over the knob, per type (provisional
// ranges: OD gentle, distortion more, fuzz a lot; to be tuned by ear).
inline float DriveGainDb(float k, int type) {
  static const float lo[3] = {0.0f, 12.0f, 24.0f};
  static const float hi[3] = {24.0f, 42.0f, 54.0f};
  const int t = type < 0 ? 0 : (type > 2 ? 2 : type);
  return lo[t] + (hi[t] - lo[t]) * Clamp(k, 0.0f, 1.0f);
}

// Tone: tilt of +-6 dB around 800 Hz, 12 o'clock = flat. Returns the tilt in dB.
inline float DriveToneDb(float k) { return (Clamp(k, 0.0f, 1.0f) - 0.5f) * 12.0f; }

// Page LOOP. Send (K2) and return (K5) level: -12..+12 dB, 12 o'clock = 0 dB.
inline float LoopLevelDb(float k) { return -12.0f + 24.0f * Clamp(k, 0.0f, 1.0f); }
// Fine trim (K6) around the measured loop latency: -1..+1 ms, linear, with a
// small dead band at 12 o'clock so the measured value is easy to hit exactly.
inline float LoopFineMs(float k) {
  const float c = Clamp(k, 0.0f, 1.0f) - 0.5f;
  constexpr float kDead = 0.02f;
  if (c > kDead) return (c - kDead) / (0.5f - kDead);
  if (c < -kDead) return (c + kDead) / (0.5f - kDead);
  return 0.0f;
}

}  // namespace bm
