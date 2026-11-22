// Drive stage for the high band with the three types from switch S3.
// Hardware-free. Provisional character, tuned by ear later:
//   Overdrive  : tanh with a slight asymmetry (soft, 2x oversampling)
//   Distortion : cubic soft clipper (linear until near full scale, then a firm knee), 4x
//                (originally planned as 2x; measured: its hard knee aliases at -21 dB with 2x, see
//                test_drive.cpp, so it gets 4x like the fuzz)
//   Fuzz       : hard clip with an offset (even harmonics, 4x oversampling)
//
// Signal flow:  x -> pre-gain -> oversampled shaper -> DC blocker -> tone tilt
//               -> level -> mixed with the delayed dry signal (on/off, type change)
//
// The stage ALWAYS has the same latency (kLatency samples): the dry/off path is
// a plain delay of that length, and the low band has to be delayed by the same
// amount (BassChain does), so the crossover sum stays flat and switching the
// drive on or off never changes the timing. The oversamplers' group delay is
// 14.5 (2x, padded by 4) and 17.75 (4x) samples; the residual is at most half a
// sample (10 us).
#pragma once

#include <cmath>

#include "dsp/dc_blocker.h"
#include "dsp/delay.h"
#include "dsp/mapping.h"
#include "dsp/math_utils.h"
#include "dsp/oversampler.h"
#include "dsp/smoother.h"

namespace bm {

struct DriveParams {
  bool on = false;
  int type = 1;           // 0 overdrive, 1 distortion, 2 fuzz
  float gain = 0.5f;      // K2
  float level = 0.5f;     // K5, 12 o'clock = loudness of the drive switched off
  float tone = 0.5f;      // K6
};

class DriveStage {
 public:
  static constexpr int kLatency = 18;  // samples, see above

  // Loudness match per type in dB (one constant per drive type).
  // Provisional: RMS match on a 4-tone reference at -20 dBFS peak with the default
  // gain and a flat tone (see test_drive.cpp), to be tuned by ear.
  static constexpr float LevelMatchDb(int type) {
    return type == 0 ? -11.75f : (type == 1 ? -25.94f : -27.52f);
  }

  void Init(float sample_rate, const DriveParams& p) {
    fs_ = sample_rate;
    active_type_ = pending_type_ = p.type;
    dry_.Init(kLatency);
    pad_.Init(kLatency - 14);  // 2x path: 14.5 + 4 = 18.5
    InitChain(active_type_);
    wet_.Init(fs_, 0.00125f, p.on ? 1.0f : 0.0f);  // ~5 ms to 98 %
    gain_.Init(fs_, 0.010f, DbToLin(DriveGainDb(p.gain, p.type)));
    level_.Init(fs_, 0.010f, MasterGain(p.level));
    const float t = DriveToneDb(p.tone);
    tilt_lo_.Init(fs_, 0.010f, DbToLin(-t));
    tilt_hi_.Init(fs_, 0.010f, DbToLin(t));
    // trapezoidal (bilinear) one-pole: its response is exactly zero at Nyquist, so the
    // tilt reaches its full +-6 dB at both ends (a backward-Euler one-pole did not)
    const float w = 3.14159265f * 800.0f / fs_;
    const float g = sinf(w) / cosf(w);
    tilt_g_ = g / (1.0f + g);
    on_ = p.on;
  }

  void SetParams(const DriveParams& p) {
    on_ = p.on;
    pending_type_ = p.type;
    gain_.SetTarget(DbToLin(DriveGainDb(p.gain, p.type)));
    level_.SetTarget(MasterGain(p.level));
    const float t = DriveToneDb(p.tone);
    tilt_lo_.SetTarget(DbToLin(-t));
    tilt_hi_.SetTarget(DbToLin(t));
  }

  float Process(float x) {
    const float dry = dry_.Process(x);

    // On/off and type changes: ramp the wet path down, switch while it is silent, ramp up.
    const bool want_wet = on_ && (active_type_ == pending_type_);
    wet_.SetTarget(want_wet ? 1.0f : 0.0f);
    const float wet = wet_.Process();
    if (active_type_ != pending_type_ && wet < 0.002f) {
      active_type_ = pending_type_;
      InitChain(active_type_);
    }
    if (wet < 0.0005f && !on_) {  // off: nothing to compute, the chain goes cold
      cold_ = true;
      return dry;
    }
    if (cold_) {                  // switched on again: start from clean filter states
      InitChain(active_type_);
      cold_ = false;
    }

    // --- wet path
    const float pre = x * gain_.Process();
    float y;
    if (active_type_ == 2) {
      y = os_.Process(pre, [](float s) { return FuzzShape(s); });
    } else if (active_type_ == 1) {
      y = os_.Process(pre, [](float s) { return DistShape(s); });
    } else {
      y = pad_.Process(os_.Process(pre, [](float s) { return OdShape(s); }));
    }
    y = dc_.Process(y);
    // tone: one-pole split at 800 Hz, lows and highs weighted oppositely
    const float v = (y - tilt_s_) * tilt_g_;
    const float lp = v + tilt_s_;
    tilt_s_ = lp + v;
    y = tilt_lo_.Process() * lp + tilt_hi_.Process() * (y - lp);
    y *= level_.Process() * match_lin_;

    return dry * (1.0f - wet) + y * wet;
  }

  int active_type() const { return active_type_; }

  // Shapers: memoryless, output about +-1.
  static float OdShape(float s) { return FastTanh(s + 0.1f) - 0.0997f; }
  static float DistShape(float s) {
    if (s >= 1.0f) return 1.0f;
    if (s <= -1.0f) return -1.0f;
    return 1.5f * (s - s * s * s * (1.0f / 3.0f));  // unity peak, flat top (slope 0 at +-1)
  }
  static float FuzzShape(float s) {
    s += 0.08f;
    return s > 1.0f ? 1.0f : (s < -1.0f ? -1.0f : s);
  }

 private:
  void InitChain(int type) {
    os_.Init(type == 0 ? 2 : 4);   // only the overdrive is soft enough for 2x
    pad_.Init(kLatency - 14);
    dc_.Init(fs_);
    tilt_s_ = 0.0f;
    match_lin_ = DbToLin(LevelMatchDb(type));  // once per type change, not per sample
  }

  float fs_ = 48000.0f;
  bool on_ = false;
  bool cold_ = false;
  int active_type_ = 1, pending_type_ = 1;
  float tilt_g_ = 0.1f, tilt_s_ = 0.0f, match_lin_ = 1.0f;
  Delay dry_, pad_;
  Oversampler os_;
  DcBlocker dc_;
  Smoother wet_, gain_, level_, tilt_lo_, tilt_hi_;
};

}  // namespace bm
