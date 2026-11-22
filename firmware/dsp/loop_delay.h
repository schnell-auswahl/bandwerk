// Fractional delay line for the FX-loop latency compensation.
// Cubic interpolation: at 10 kHz and a fraction of 0.81 the loss is 0.3 dB
// (linear interpolation would lose about 1.1 dB). Only the dry part of the
// loop mix (mix < 100 %) and the low band go through it.
// Hardware-free, no allocation.
//
// Small changes of the delay (the trim knob) glide; a large jump (switching
// between Bridge = 0 and Loop = round trip) crossfades between the old and the
// new read position in ~20 ms instead, so there is no pitch sweep and no click.
// Two instances fed with the same targets stay sample-exact in step.
#pragma once

#include <cmath>

namespace bm {

class LoopDelay {
 public:
  static constexpr int kSize = 1024;              // power of two (~21 ms)
  static constexpr float kMaxDelay = kSize - 2;   // samples
  static constexpr float kJump = 2.0f;            // larger target changes crossfade

  void Init(float sample_rate, float delay_samples) {
    for (float& v : buf_) v = 0.0f;
    w_ = 0;
    target_ = Clamp(delay_samples);
    d_a_ = d_b_ = target_;
    fading_ = false;
    fade_ = 0.0f;
    fade_step_ = 1.0f / (0.020f * sample_rate);
    glide_ = 1.0f - expf(-1.0f / (0.050f * sample_rate));
  }

  void SetTarget(float delay_samples) { target_ = Clamp(delay_samples); }

  float Process(float x) {
    buf_[w_] = x;
    if (!fading_) {
      if (fabsf(target_ - d_a_) > kJump) {
        d_b_ = target_;
        fade_ = 0.0f;
        fading_ = true;
      } else {
        d_a_ += glide_ * (target_ - d_a_);
        if (fabsf(target_ - d_a_) < 1.0e-4f) d_a_ = target_;
      }
    }
    float y;
    if (fading_) {
      const float a = Read(d_a_);
      y = a + (Read(d_b_) - a) * fade_;
      fade_ += fade_step_;
      if (fade_ >= 1.0f) {
        d_a_ = d_b_;
        fading_ = false;
      }
    } else {
      y = Read(d_a_);
    }
    w_ = (w_ + 1) & kMask;
    return y;
  }

  float delay() const { return d_a_; }  // current read position (samples)
  bool fading() const { return fading_; }

 private:
  static constexpr int kMask = kSize - 1;

  static float Clamp(float d) { return d < 0.0f ? 0.0f : (d > kMaxDelay ? kMaxDelay : d); }

  // Cubic (4-point Lagrange) interpolation, exact at whole samples. Below one
  // sample (only while gliding towards Bridge) it falls back to linear, as
  // there is no newer sample to interpolate with.
  float Read(float d) const {
    const int n = static_cast<int>(d);
    const float f = d - static_cast<float>(n);
    const float x0 = buf_[(w_ - n) & kMask];
    if (f == 0.0f) return x0;
    const float x1 = buf_[(w_ - n - 1) & kMask];
    if (n < 1) return x0 + (x1 - x0) * f;
    const float xm = buf_[(w_ - n + 1) & kMask];
    const float x2 = buf_[(w_ - n - 2) & kMask];
    const float c_m = -f * (f - 1.0f) * (f - 2.0f) / 6.0f;
    const float c_0 = (f + 1.0f) * (f - 1.0f) * (f - 2.0f) / 2.0f;
    const float c_1 = -(f + 1.0f) * f * (f - 2.0f) / 2.0f;
    const float c_2 = (f + 1.0f) * f * (f - 1.0f) / 6.0f;
    return c_m * xm + c_0 * x0 + c_1 * x1 + c_2 * x2;
  }

  float buf_[kSize];
  int w_ = 0;
  float target_ = 0.0f, d_a_ = 0.0f, d_b_ = 0.0f;
  bool fading_ = false;
  float fade_ = 0.0f, fade_step_ = 0.0f, glide_ = 0.0f;
};

}  // namespace bm
