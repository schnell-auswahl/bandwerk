// Linkwitz-Riley 4th order crossover: each band is two cascaded
// Butterworth biquads (Q = 1/sqrt(2)). LP and HP are phase aligned, their sum
// has a flat magnitude (it is an allpass), no polarity flip needed.
#pragma once

#include "dsp/biquad.h"

namespace bm {

class CrossoverLR4 {
 public:
  static constexpr double kQ = 0.70710678118654752;

  void Init(float sample_rate, float fc) {
    fs_ = sample_rate;
    SetFrequency(fc);
    Reset();
  }

  void SetFrequency(float fc) {
    const BiquadCoeffs lp = DesignLowpass(fc, fs_, kQ);
    const BiquadCoeffs hp = DesignHighpass(fc, fs_, kQ);
    for (int i = 0; i < 2; ++i) {
      lp_[i].SetCoeffs(lp);
      hp_[i].SetCoeffs(hp);
    }
  }

  void Reset() {
    for (int i = 0; i < 2; ++i) {
      lp_[i].Reset();
      hp_[i].Reset();
    }
  }

  void Process(float x, float* low, float* high) {
    *low = static_cast<float>(lp_[1].ProcessD(lp_[0].ProcessD(x)));
    *high = static_cast<float>(hp_[1].ProcessD(hp_[0].ProcessD(x)));
  }

 private:
  float fs_ = 48000.0f;
  Biquad lp_[2];
  Biquad hp_[2];
};

}  // namespace bm
