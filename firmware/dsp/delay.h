// Integer sample delay line. Hardware-free, no allocation (fixed 64 samples).
#pragma once

#include <cstdint>

namespace bm {

class Delay {
 public:
  static constexpr int kMax = 63;

  void Init(int samples) {
    samples_ = samples < 0 ? 0 : (samples > kMax ? kMax : samples);
    for (float& v : buf_) v = 0.0f;
    pos_ = 0;
  }

  float Process(float x) {
    buf_[pos_] = x;
    const float y = buf_[(pos_ - samples_) & kMask];
    pos_ = (pos_ + 1) & kMask;
    return y;
  }

  int samples() const { return samples_; }

 private:
  static constexpr int kMask = 63;
  float buf_[64];
  int samples_ = 0;
  int pos_ = 0;
};

}  // namespace bm
