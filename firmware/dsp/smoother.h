// One-pole parameter smoother (the same idea as daisysp::fonepole), with the
// time constant given in seconds. Hardware-free.
#pragma once

#include <cmath>

namespace bm {

class Smoother {
 public:
  // `rate_hz` is how often Process() is called.
  void Init(float rate_hz, float time_constant_s, float initial) {
    coef_ = 1.0f - expf(-1.0f / (rate_hz * time_constant_s));
    value_ = target_ = initial;
  }
  void SetTarget(float t) { target_ = t; }
  void JumpTo(float v) { value_ = target_ = v; }
  float Process() {
    value_ += coef_ * (target_ - value_);
    return value_;
  }
  float value() const { return value_; }
  float target() const { return target_; }

 private:
  float coef_ = 1.0f;
  float value_ = 0.0f;
  float target_ = 0.0f;
};

}  // namespace bm
