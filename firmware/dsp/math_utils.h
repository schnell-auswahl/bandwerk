// Small hardware-free math helpers shared by DSP and UI code.
#pragma once

#include <cmath>
#include <cstdint>
#include <cstring>

namespace bm {

constexpr float kPi = 3.14159265358979f;
constexpr float kTwoPi = 6.28318530717959f;

// Floor used when converting a linear value to dB (avoids -inf).
constexpr float kDbFloor = -120.0f;

inline float DbToLin(float db) { return powf(10.0f, db * 0.05f); }

inline float LinToDb(float lin) {
  const float floor_lin = 1.0e-6f;  // -120 dB
  return lin > floor_lin ? 20.0f * log10f(lin) : kDbFloor;
}

// Fast log2 for positive, normal floats (exponent from the bit pattern plus a
// rational approximation of the mantissa). The error stays below 0.0002 in
// log2, i.e. below 0.002 dB: far below anything audible, at a fraction of the
// cost of log10f (the compressor detectors call it for every sample).
inline float FastLog2(float x) {
  uint32_t bits;
  std::memcpy(&bits, &x, sizeof bits);
  const uint32_t mant_bits = (bits & 0x007FFFFFu) | 0x3F000000u;  // mantissa in [0.5, 1)
  float m;
  std::memcpy(&m, &mant_bits, sizeof m);
  const float y = static_cast<float>(bits) * 1.1920928955078125e-7f;  // exponent + mantissa
  return y - 124.22551499f - 1.498030302f * m - 1.72587999f / (0.3520887068f + m);
}

// 20 log10(x) for positive x.
inline float FastDb(float x) { return 6.02059991f * FastLog2(x); }

// tanh by a [7/6] Pade approximation (error below 1e-6 for |x| < 4.97, then +-1).
inline float FastTanh(float x) {
  if (x > 4.97f) return 1.0f;
  if (x < -4.97f) return -1.0f;
  const float x2 = x * x;
  const float num = x * (135135.0f + x2 * (17325.0f + x2 * (378.0f + x2)));
  const float den = 135135.0f + x2 * (62370.0f + x2 * (3150.0f + 28.0f * x2));
  return num / den;
}

inline float Clamp(float x, float lo, float hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

}  // namespace bm
