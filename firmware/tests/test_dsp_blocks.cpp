#include <cmath>
#include <complex>
#include <vector>

#include "dsp/biquad.h"
#include "dsp/crossover_lr4.h"
#include "dsp/dc_blocker.h"
#include "dsp/mapping.h"
#include "dsp/smoother.h"
#include "dsp/soft_clip.h"
#include "test_framework.h"

using namespace bm;

namespace {

constexpr float kFs = 48000.0f;

// Magnitude (dB) of an impulse response at frequency f (direct DFT).
double MagDb(const std::vector<double>& ir, double f) {
  std::complex<double> acc(0.0, 0.0);
  for (size_t n = 0; n < ir.size(); ++n) {
    const double w = 2.0 * 3.14159265358979323846 * f * n / kFs;
    acc += ir[n] * std::complex<double>(cos(w), -sin(w));
  }
  return 20.0 * log10(std::abs(acc));
}

struct Irs {
  std::vector<double> low, high, sum;
};

Irs CrossoverImpulse(float fc, int n = 48000) {
  CrossoverLR4 x;
  x.Init(kFs, fc);
  Irs r;
  for (int i = 0; i < n; ++i) {
    float lo, hi;
    x.Process(i == 0 ? 1.0f : 0.0f, &lo, &hi);
    r.low.push_back(lo);
    r.high.push_back(hi);
    r.sum.push_back(static_cast<double>(lo) + hi);
  }
  return r;
}

}  // namespace

TEST(crossover_frequency_mapping) {
  CHECK_NEAR(CrossoverHz(0.0f), 100.0, 0.01);
  CHECK_NEAR(CrossoverHz(0.5f), 250.0, 0.01);  // 12 o'clock
  CHECK_NEAR(CrossoverHz(1.0f), 800.0, 0.05);
  float prev = 0.0f;
  for (float k = 0.0f; k <= 1.0f; k += 0.01f) {
    const float f = CrossoverHz(k);
    CHECK(f > prev);
    prev = f;
  }
}

TEST(biquad_butterworth_corner_values) {
  // single Butterworth section: -3.01 dB at fc, unity at DC (LP) / Nyquist (HP)
  Biquad lp;
  lp.SetCoeffs(DesignLowpass(1000.0, kFs, CrossoverLR4::kQ));
  std::vector<double> ir;
  for (int i = 0; i < 16000; ++i) ir.push_back(lp.Process(i == 0 ? 1.0f : 0.0f));
  CHECK_NEAR(MagDb(ir, 1000.0), -3.01, 0.05);
  CHECK_NEAR(MagDb(ir, 5.0), 0.0, 0.05);
  Biquad hp;
  hp.SetCoeffs(DesignHighpass(1000.0, kFs, CrossoverLR4::kQ));
  ir.clear();
  for (int i = 0; i < 16000; ++i) ir.push_back(hp.Process(i == 0 ? 1.0f : 0.0f));
  CHECK_NEAR(MagDb(ir, 1000.0), -3.01, 0.05);
  CHECK_NEAR(MagDb(ir, 23000.0), 0.0, 0.1);
}

TEST(lr4_bands_are_minus_6db_at_crossover_and_24db_per_octave) {
  for (float fc : {100.0f, 250.0f, 800.0f}) {
    const Irs r = CrossoverImpulse(fc);
    CHECK_NEAR(MagDb(r.low, fc), -6.02, 0.1);
    CHECK_NEAR(MagDb(r.high, fc), -6.02, 0.1);
    // analytic LR4: |H| = 1 / (1 + (f/fc)^4)
    const double f2 = 2.0 * fc;
    CHECK_NEAR(MagDb(r.low, f2), -20.0 * log10(1.0 + 16.0), 0.4);
    CHECK_NEAR(MagDb(r.high, fc / 2.0), -20.0 * log10(1.0 + 16.0), 0.4);
  }
}

// Acceptance: LOW + HIGH has a flat magnitude within +-0.1 dB.
// (The sum of an LR4 pair is an allpass: flat magnitude, but it shifts the
// phase, so it is not identical to the input sample by sample.)
TEST(lr4_sum_is_flat_within_0_1_db) {
  const double freqs[] = {20,   25,   31.5, 40,   50,   63,   80,   100,  125,
                          160,  200,  250,  315,  400,  500,  630,  800,  1000,
                          1250, 1600, 2000, 3150, 5000, 8000, 12500, 16000, 20000};
  for (float fc : {100.0f, 250.0f, 800.0f}) {
    const Irs r = CrossoverImpulse(fc);
    double worst = 0.0;
    for (double f : freqs) worst = std::max(worst, fabs(MagDb(r.sum, f)));
    CHECK(worst <= 0.1);
    std::printf("    fc=%.0f Hz: worst deviation of LOW+HIGH %.4f dB\n", fc, worst);
  }
}

// The output must follow a double-precision reference closely, even at the
// lowest crossover frequency (poles close to z = 1). With float filter state
// this was only -84 dB; that is the reason the biquads run in double.
TEST(lr4_output_matches_double_reference) {
  const double fc = 100.0;
  const BiquadCoeffs c = DesignLowpass(fc, kFs, CrossoverLR4::kQ);
  // double-precision TDF2 with the same (float-quantized) coefficients
  double z1[2] = {0, 0}, z2[2] = {0, 0};
  CrossoverLR4 x;
  x.Init(kFs, static_cast<float>(fc));
  double err2 = 0.0, ref2 = 0.0;
  unsigned seed = 12345;
  for (int i = 0; i < 96000; ++i) {
    seed = seed * 1664525u + 1013904223u;
    const float in = (static_cast<float>(seed >> 8) / 8388608.0f - 1.0f) * 0.5f;
    double v = in;
    for (int s = 0; s < 2; ++s) {
      const double y = c.b0 * v + z1[s];
      z1[s] = c.b1 * v - c.a1 * y + z2[s];
      z2[s] = c.b2 * v - c.a2 * y;
      v = y;
    }
    float lo, hi;
    x.Process(in, &lo, &hi);
    err2 += (lo - v) * (lo - v);
    ref2 += v * v;
  }
  const double err_db = 10.0 * log10(err2 / ref2);
  std::printf("    output vs double reference error: %.1f dB\n", err_db);
  CHECK(err_db < -130.0);
}

TEST(master_curve_matches_spec) {
  CHECK_NEAR(MasterGain(0.0f), 0.0, 1e-9);                    // -inf
  CHECK_NEAR(MasterGain(0.5f), 1.0, 1e-6);                    // 0 dB
  CHECK_NEAR(20.0 * log10(MasterGain(1.0f)), 6.0, 1e-3);      // +6 dB
  float prev = -1.0f;
  for (float k = 0.0f; k <= 1.0f; k += 0.005f) {
    const float g = MasterGain(k);
    CHECK(g >= prev);
    prev = g;
  }
  CHECK(MasterGain(0.25f) < MasterGain(0.5f));
  // no jump at 12 o'clock, and the fixed points of the taper
  CHECK_NEAR(MasterGain(0.499f), 1.0, 0.01);
  CHECK_NEAR(MasterGain(0.501f), 1.0, 0.01);
  CHECK_NEAR(MasterGain(0.25f), 0.25, 1e-6);   // about -12 dB
  CHECK_NEAR(MasterGain(0.75f), pow(10.0, 3.0 / 20.0), 1e-5);  // +3 dB
}

TEST(band_mixer_matches_spec) {
  float lo, hi;
  BandMixGains(0.5f, &lo, &hi);
  CHECK_NEAR(lo, 1.0, 1e-9);
  CHECK_NEAR(hi, 1.0, 1e-9);
  BandMixGains(0.0f, &lo, &hi);
  CHECK_NEAR(lo, 1.0, 1e-9);
  CHECK_NEAR(hi, 0.0, 1e-9);
  BandMixGains(1.0f, &lo, &hi);
  CHECK_NEAR(lo, 0.0, 1e-9);
  CHECK_NEAR(hi, 1.0, 1e-9);
  BandMixGains(0.25f, &lo, &hi);
  CHECK_NEAR(lo, 1.0, 1e-9);
  CHECK(hi > 0.0f && hi < 1.0f);
}

TEST(soft_clip_properties) {
  // transparent up to the threshold
  for (float x = -0.7f; x <= 0.7f; x += 0.01f) CHECK_NEAR(SoftClip(x), x, 1e-7);
  // bounded, monotonic and odd for any input
  float prev = -2.0f;
  for (float x = -10.0f; x <= 10.0f; x += 0.01f) {
    const float y = SoftClip(x);
    CHECK(fabsf(y) < 1.0f + 1e-6f);
    CHECK(y >= prev - 1e-7f);
    CHECK_NEAR(SoftClip(-x), -y, 1e-6);
    prev = y;
  }
  // continuous slope at the knee
  const float d1 = (SoftClip(0.7f) - SoftClip(0.699f)) / 0.001f;
  const float d2 = (SoftClip(0.701f) - SoftClip(0.7f)) / 0.001f;
  CHECK_NEAR(d1, d2, 0.01);
  CHECK(SoftClip(0.7f + 1e-4f) < 1.0f);
}

TEST(dc_blocker_removes_offset_and_passes_bass) {
  DcBlocker dc;
  dc.Init(kFs);
  float y = 0.0f;
  for (int i = 0; i < 48000; ++i) y = dc.Process(0.3f);
  CHECK(fabsf(y) < 1e-3f);
  // A 5 Hz one-pole high-pass costs 0.06 dB at 41 Hz (low E), as expected
  // analytically: -10 log10(1 + (5 / 41.2)^2).
  DcBlocker d2;
  d2.Init(kFs);
  double peak = 0.0;
  for (int i = 0; i < 48000; ++i) {
    const float o = d2.Process(sinf(2.0f * 3.14159265f * 41.2f * i / kFs));
    if (i > 24000) peak = std::max(peak, static_cast<double>(fabsf(o)));
  }
  CHECK_NEAR(20.0 * log10(peak), -10.0 * log10(1.0 + (5.0 / 41.2) * (5.0 / 41.2)), 0.02);
}

TEST(smoother_converges_without_overshoot) {
  Smoother s;
  s.Init(kFs, 0.010f, 0.0f);
  s.SetTarget(1.0f);
  float prev = 0.0f;
  for (int i = 0; i < 48000; ++i) {
    const float v = s.Process();
    CHECK(v >= prev && v <= 1.0f);
    prev = v;
  }
  CHECK_NEAR(prev, 1.0, 1e-4);
}
