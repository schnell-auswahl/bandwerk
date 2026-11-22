// Peak envelope follower with hold: |x| is held with an exponential fall-off
// (so the gaps between the peaks of a low note do not show), then smoothed
// with separate attack and release times. Hardware-free.
#pragma once

#include <cmath>

namespace bm {

class PeakEnvelope {
 public:
  void Init(float sample_rate, float hold_ms, float attack_ms, float release_ms) {
    hold_ = expf(-1.0f / (sample_rate * hold_ms * 0.001f));
    attack_ = expf(-1.0f / (sample_rate * attack_ms * 0.001f));
    release_ = expf(-1.0f / (sample_rate * release_ms * 0.001f));
    held_ = env_ = 0.0f;
  }

  float Process(float x) {
    const float ax = fabsf(x);
    const float h = held_ * hold_;
    held_ = ax > h ? ax : h;
    if (held_ < 1.0e-12f) held_ = 0.0f;  // no denormals in silence
    const float c = held_ > env_ ? attack_ : release_;
    env_ = c * env_ + (1.0f - c) * held_;
    if (env_ < 1.0e-12f) env_ = 0.0f;
    return env_;
  }

  float value() const { return env_; }

 private:
  float hold_ = 0.99f, attack_ = 0.99f, release_ = 0.999f;
  float held_ = 0.0f, env_ = 0.0f;
};

}  // namespace bm
