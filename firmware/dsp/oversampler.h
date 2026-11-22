// Half-band oversampling for the drive stage. Hardware-free.
//
// Polyphase half-band FIR (Kaiser window) for 2x; two of them in cascade give
// 4x. A half-band filter has every second tap equal to zero, so only about
// half of the taps are computed. With L the (odd) half length:
//   up   : even phase = FIR over the input, odd phase = delayed input (center tap)
//   down : center tap on the even phase, FIR over the odd phase
// A round trip (up, then down) has unity gain and a linear-phase delay of
// L - 1/2 samples of the lower rate.
#pragma once

#include <cmath>

namespace bm {

constexpr int kMaxHalfLength = 15;  // taps: 2 * 15 + 1 = 31

// Half-band prototype: h[k], DC gain 1, nonzero only at k = 0 and odd k.
struct HalfbandTaps {
  int L = 15;
  float odd[kMaxHalfLength + 1];  // odd[i] = h[2i - L], i = 0..L  (L odd: all odd k)

  // L must be odd and <= kMaxHalfLength. beta: Kaiser window parameter.
  void Design(int half_length, float beta) {
    L = half_length;
    const double pi = 3.14159265358979323846;
    // Bessel I0 by its power series
    auto i0 = [](double x) {
      double sum = 1.0, term = 1.0;
      for (int k = 1; k < 30; ++k) {
        term *= (x / (2.0 * k)) * (x / (2.0 * k));
        sum += term;
      }
      return sum;
    };
    const double i0b = i0(beta);
    double h[2 * kMaxHalfLength + 1];
    double sum = 0.0;
    for (int k = -L; k <= L; ++k) {
      double v;
      if (k == 0) {
        v = 0.5;
      } else if ((k & 1) == 0) {
        v = 0.0;
      } else {
        const int a = k < 0 ? -k : k;
        const double sgn = (((a - 1) / 2) & 1) ? -1.0 : 1.0;  // sin(pi k / 2) for odd k
        v = sgn / (pi * a);
      }
      const double r = static_cast<double>(k) / (L + 1);
      const double w = i0(beta * sqrt(1.0 - r * r)) / i0b;
      h[k + L] = v * w;
      sum += h[k + L];
    }
    for (int i = 0; i <= L; ++i) odd[i] = static_cast<float>(h[(2 * i - L) + L] / sum);
    center_ = static_cast<float>(h[L] / sum);
  }

  float center() const { return center_; }

 private:
  float center_ = 0.5f;
};

// 2x up-sampler: one input sample in, two samples out (out0 first in time).
class HalfbandUp2 {
 public:
  void Init(const HalfbandTaps& t) {
    taps_ = t;
    for (float& v : hist_) v = 0.0f;
    pos_ = 0;
  }

  void Process(float x, float* out0, float* out1) {
    hist_[pos_] = x;
    float acc = 0.0f;
    for (int j = 0; j <= taps_.L; ++j) acc += 2.0f * taps_.odd[j] * hist_[(pos_ - j) & 31];
    *out0 = acc;                                          // v[2n]
    *out1 = hist_[(pos_ - (taps_.L - 1) / 2) & 31];       // v[2n+1], center tap (gain 1)
    pos_ = (pos_ + 1) & 31;
  }

 private:
  HalfbandTaps taps_;
  float hist_[32];
  int pos_ = 0;
};

// 2x down-sampler: two input samples (e first, then o) in, one sample out.
class HalfbandDown2 {
 public:
  void Init(const HalfbandTaps& t) {
    taps_ = t;
    for (float& v : e_) v = 0.0f;
    for (float& v : o_) v = 0.0f;
    pos_ = 0;
  }

  float Process(float e, float o) {
    e_[pos_] = e;
    o_[pos_] = o;
    float acc = taps_.center() * e_[(pos_ - (taps_.L - 1) / 2) & 31];
    for (int i = 0; i <= taps_.L; ++i) acc += taps_.odd[i] * o_[(pos_ - i) & 31];
    pos_ = (pos_ + 1) & 31;
    return acc;
  }

 private:
  HalfbandTaps taps_;
  float e_[32], o_[32];
  int pos_ = 0;
};

// Runs a memoryless shaper at 2x or 4x the sample rate.
class Oversampler {
 public:
  // factor: 2 or 4. Group delay in samples of the base rate (measured, test_oversampler):
  // 14.5 (2x) and 17.75 (4x), the same at every frequency.
  void Init(int factor) {
    factor_ = factor;
    HalfbandTaps t1, t2;
    t1.Design(15, 7.0f);   // about 70 dB stopband
    t2.Design(7, 6.0f);    // second stage sees the images far above: shorter is enough
    up1_.Init(t1);
    down1_.Init(t1);
    up2_.Init(t2);
    down2_.Init(t2);
  }

  template <typename Shaper>
  float Process(float x, Shaper shape) {
    float a0, a1;
    up1_.Process(x, &a0, &a1);
    if (factor_ == 2) {
      return down1_.Process(shape(a0), shape(a1));
    }
    float s0, s1, s2, s3;
    up2_.Process(a0, &s0, &s1);
    up2_.Process(a1, &s2, &s3);
    const float b0 = down2_.Process(shape(s0), shape(s1));
    const float b1 = down2_.Process(shape(s2), shape(s3));
    return down1_.Process(b0, b1);
  }

  int factor() const { return factor_; }

 private:
  int factor_ = 2;
  HalfbandUp2 up1_, up2_;
  HalfbandDown2 down1_, down2_;
};

}  // namespace bm
