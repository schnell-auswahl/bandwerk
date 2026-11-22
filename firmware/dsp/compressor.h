// Feed-forward compressor, one instance per band. Hardware-free.
//
//   level  : |x| in dB (peak detector with a short hold)
//   curve  : static gain computer with a 6 dB soft knee
//   timing : the gain reduction is smoothed in the dB domain with a fixed
//            attack and an adjustable release (branching detector, the
//            usual "smooth decoupled peak" topology)
//   makeup : -threshold * (1 - 1/ratio) * 0.6, applied to the compressed
//            (wet) path; dry/wet is a parallel mix
//
// The detector always runs; with dry/wet at 0 the gain stage is skipped.
#pragma once

#include <cmath>

#include "dsp/math_utils.h"
#include "dsp/smoother.h"

namespace bm {

struct CompressorSettings {
  float threshold_db = -18.0f;
  float ratio = 3.0f;
  float release_ms = 80.0f;
  float dry_wet = 0.6f;  // 0 = dry only, 1 = compressed only
};

class Compressor {
 public:
  static constexpr float kKneeDb = 6.0f;

  // Output level in dB for an input level in dB (gain computer, no makeup).
  static float StaticCurve(float x_db, float thr_db, float ratio) {
    const float o = x_db - thr_db;
    if (2.0f * o < -kKneeDb) return x_db;
    if (2.0f * fabsf(o) <= kKneeDb) {
      const float t = o + 0.5f * kKneeDb;
      return x_db + (1.0f / ratio - 1.0f) * t * t / (2.0f * kKneeDb);
    }
    return thr_db + o / ratio;
  }

  static float MakeupDb(float thr_db, float ratio) {
    return -thr_db * (1.0f - 1.0f / ratio) * 0.6f;
  }

  void Init(float sample_rate, float attack_ms, const CompressorSettings& s,
            float hold_ms = 0.0f) {
    fs_ = sample_rate;
    attack_coef_ = expf(-1.0f / (fs_ * attack_ms * 0.001f));
    hold_coef_ = hold_ms > 0.0f ? expf(-1.0f / (fs_ * hold_ms * 0.001f)) : 0.0f;
    level_ = 0.0f;
    thr_.Init(fs_, 0.020f, s.threshold_db);
    ratio_.Init(fs_, 0.020f, s.ratio);
    dry_wet_.Init(fs_, 0.020f, s.dry_wet);
    SetRelease(s.release_ms);
    gr_db_ = 0.0f;
    max_gr_db_ = 0.0f;
  }

  // Safe to call every block; the values are smoothed per sample.
  void SetParams(const CompressorSettings& s) {
    thr_.SetTarget(s.threshold_db);
    ratio_.SetTarget(s.ratio);
    dry_wet_.SetTarget(s.dry_wet);
    SetRelease(s.release_ms);
  }

  float Process(float x) {
    const float thr = thr_.Process();
    const float ratio = ratio_.Process();
    const float dw = dry_wet_.Process();

    // Peak detector with a short hold: the level falls off exponentially
    // between the peaks, so low notes (peaks far apart) do not make the gain
    // reduction breathe within every cycle.
    const float ax = fabsf(x);
    const float held = level_ * hold_coef_;  // 0 without hold: level = |x|
    level_ = ax > held ? ax : held;
    if (level_ < 1.0e-12f) level_ = 0.0f;
    const float lv = level_;
    const float x_db = lv > 1.0e-9f ? FastDb(lv) : -180.0f;
    const float target = x_db - StaticCurve(x_db, thr, ratio);  // >= 0

    const float c = target > gr_db_ ? attack_coef_ : release_coef_;
    gr_db_ = c * gr_db_ + (1.0f - c) * target;
    if (gr_db_ < 1.0e-9f) gr_db_ = 0.0f;  // no denormals in silence
    if (gr_db_ > max_gr_db_) max_gr_db_ = gr_db_;

    if (dw < 0.0005f) return x;  // detector keeps running, gain stage skipped
    const float wet = expf(0.115129255f * (MakeupDb(thr, ratio) - gr_db_));
    return x * ((1.0f - dw) + dw * wet);
  }

  // Current gain reduction in dB (>= 0, before makeup).
  float gain_reduction_db() const { return gr_db_; }

  // Largest gain reduction since the last call (for the meters).
  float TakeMaxGainReductionDb() {
    const float m = max_gr_db_;
    max_gr_db_ = gr_db_;
    return m;
  }

 private:
  void SetRelease(float ms) {
    release_coef_ = expf(-1.0f / (fs_ * ms * 0.001f));
  }

  float fs_ = 48000.0f;
  float attack_coef_ = 0.99f, release_coef_ = 0.999f, hold_coef_ = 0.0f;
  float level_ = 0.0f;
  float gr_db_ = 0.0f, max_gr_db_ = 0.0f;
  Smoother thr_, ratio_, dry_wet_;
};

}  // namespace bm
