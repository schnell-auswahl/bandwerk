// Biquad filter (transposed direct form II) with RBJ-cookbook Butterworth
// low-/high-pass design. Hardware-free. Coefficients and state are double:
// with float state the poles close to z = 1 (100 Hz at 48 kHz) limit the
// accuracy to about 14 bit (-84 dB), which would be audible on the bass band.
// The Cortex-M7 FPU (fpv5-d16) does double precision in hardware.
#pragma once

#include <cmath>

#include "dsp/math_utils.h"

namespace bm {

struct BiquadCoeffs {
  double b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0;  // a0 = 1
};

inline BiquadCoeffs DesignLowpass(double fc, double fs, double q) {
  const double w0 = 2.0 * 3.14159265358979323846 * fc / fs;
  // float sin/cos: the double versions would cost about 3.5 KB of flash. LP
  // and HP use the very same cw/alpha, so their sum stays an exact allpass.
  const double cw = cosf(static_cast<float>(w0));
  const double alpha = sinf(static_cast<float>(w0)) / (2.0 * q);
  const double a0 = 1.0 + alpha;
  BiquadCoeffs c;
  c.b0 = (1.0 - cw) * 0.5 / a0;
  c.b1 = (1.0 - cw) / a0;
  c.b2 = c.b0;
  c.a1 = -2.0 * cw / a0;
  c.a2 = (1.0 - alpha) / a0;
  return c;
}

inline BiquadCoeffs DesignHighpass(double fc, double fs, double q) {
  const double w0 = 2.0 * 3.14159265358979323846 * fc / fs;
  // float sin/cos: the double versions would cost about 3.5 KB of flash. LP
  // and HP use the very same cw/alpha, so their sum stays an exact allpass.
  const double cw = cosf(static_cast<float>(w0));
  const double alpha = sinf(static_cast<float>(w0)) / (2.0 * q);
  const double a0 = 1.0 + alpha;
  BiquadCoeffs c;
  c.b0 = (1.0 + cw) * 0.5 / a0;
  c.b1 = -(1.0 + cw) / a0;
  c.b2 = c.b0;
  c.a1 = -2.0 * cw / a0;
  c.a2 = (1.0 - alpha) / a0;
  return c;
}

class Biquad {
 public:
  void SetCoeffs(const BiquadCoeffs& c) { c_ = c; }
  void Reset() { z1_ = z2_ = 0.0; }

  // Cascaded sections pass doubles between each other; use ProcessD for that.
  float Process(float x) { return static_cast<float>(ProcessD(x)); }

  double ProcessD(double x) {
    const double y = c_.b0 * x + z1_;
    z1_ = c_.b1 * x - c_.a1 * y + z2_;
    z2_ = c_.b2 * x - c_.a2 * y;
    return y;
  }

 private:
  BiquadCoeffs c_;
  double z1_ = 0.0, z2_ = 0.0;
};

}  // namespace bm
