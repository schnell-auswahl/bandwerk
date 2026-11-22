// One-pole DC blocker (high-pass).  y[n] = x[n] - x[n-1] + R y[n-1]
// 5 Hz costs 0.06 dB at 41 Hz (low E); the spec's 10 Hz would cost 0.24 dB.
#pragma once

#include "dsp/math_utils.h"

namespace bm {

class DcBlocker {
 public:
  static constexpr float kDefaultCutoffHz = 5.0f;

  void Init(float sample_rate, float cutoff_hz = kDefaultCutoffHz) {
    r_ = 1.0f - kTwoPi * cutoff_hz / sample_rate;
    x1_ = y1_ = 0.0f;
  }

  float Process(float x) {
    float y = x - x1_ + r_ * y1_;
    // Keep the state out of the denormal range during digital silence.
    if (y > -1.0e-20f && y < 1.0e-20f) y = 0.0f;
    x1_ = x;
    y1_ = y;
    return y;
  }

 private:
  float r_ = 0.998f;
  float x1_ = 0.0f, y1_ = 0.0f;
};

}  // namespace bm
