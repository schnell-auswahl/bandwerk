#include <algorithm>
#include <cmath>
#include <complex>
#include <vector>

#include "dsp/delay.h"
#include "dsp/oversampler.h"
#include "test_framework.h"

using namespace bm;

namespace {
constexpr double kPi_ = 3.14159265358979323846;

std::vector<float> RunRoundTrip(int factor, const std::vector<float>& x) {
  Oversampler os;
  os.Init(factor);
  std::vector<float> y;
  for (float v : x) y.push_back(os.Process(v, [](float s) { return s; }));
  return y;
}

double MagDb(const std::vector<float>& ir, double f, double fs = 48000.0) {
  std::complex<double> acc(0, 0);
  for (size_t n = 0; n < ir.size(); ++n)
    acc += static_cast<double>(ir[n]) * std::polar(1.0, -2.0 * kPi_ * f * n / fs);
  return 20.0 * log10(std::abs(acc));
}
}  // namespace

TEST(halfband_taps_are_a_halfband_with_unity_dc_gain) {
  HalfbandTaps t;
  t.Design(15, 7.0f);
  double sum = t.center();
  for (int i = 0; i <= t.L; ++i) sum += t.odd[i];
  CHECK_NEAR(sum, 1.0, 1e-6);
  CHECK_NEAR(t.center(), 0.5, 0.01);
  // symmetric
  for (int i = 0; i <= t.L; ++i) CHECK_NEAR(t.odd[i], t.odd[t.L - i], 1e-7);
}

TEST(delay_line_delays_exactly) {
  Delay d;
  d.Init(19);
  int first = -1;
  for (int i = 0; i < 60; ++i) {
    const float y = d.Process(i == 0 ? 1.0f : 0.0f);
    if (y > 0.5f && first < 0) first = i;
  }
  CHECK(first == 19);
  d.Init(0);
  CHECK(d.Process(0.7f) == 0.7f);
}

// Latency as the group delay of the round trip (in samples of the base rate).
double GroupDelay(int factor, double f) {
  std::vector<float> x(4096, 0.0f);
  x[0] = 1.0f;
  const std::vector<float> y = RunRoundTrip(factor, x);
  auto phase = [&](double fr) {
    std::complex<double> acc(0, 0);
    for (size_t n = 0; n < y.size(); ++n)
      acc += static_cast<double>(y[n]) * std::polar(1.0, -2.0 * kPi_ * fr * n / 48000.0);
    return std::arg(acc);
  };
  const double df = 5.0;
  double d = phase(f + df) - phase(f - df);
  while (d > kPi_) d -= 2 * kPi_;
  while (d < -kPi_) d += 2 * kPi_;
  return -d / (2.0 * kPi_ * 2.0 * df / 48000.0);
}

TEST(round_trip_latency_is_known_and_constant_across_the_band) {
  const double d2 = GroupDelay(2, 300.0), d4 = GroupDelay(4, 300.0);
  std::printf("    group delay: 2x %.2f samples, 4x %.2f samples\n", d2, d4);
  CHECK_NEAR(d2, 14.5, 0.05);     // L1 - 1/2 (L1 = 15)
  CHECK_NEAR(d4, 17.75, 0.05);    // 14.5 + (L2 - 1/2) / 2 (L2 = 7) base samples
  for (double f : {100.0, 1000.0, 5000.0, 12000.0}) {
    CHECK_NEAR(GroupDelay(2, f), d2, 0.1);   // linear phase: the same everywhere
    CHECK_NEAR(GroupDelay(4, f), d4, 0.1);
  }
}

TEST(round_trip_passband_is_flat) {
  for (int factor : {2, 4}) {
    std::vector<float> x(2048, 0.0f);
    x[0] = 1.0f;
    const std::vector<float> y = RunRoundTrip(factor, x);
    double worst = 0.0;
    for (double f : {50.0, 100.0, 500.0, 1000.0, 3000.0, 6000.0, 10000.0, 14000.0, 16000.0}) {
      worst = std::max(worst, fabs(MagDb(y, f)));
    }
    std::printf("    %dx: worst passband deviation up to 16 kHz %.3f dB; at 19 kHz %.2f dB\n", factor, worst, MagDb(y, 19000.0));
    CHECK(worst < 0.1);
  }
}

// What the oversampling is for: a hard nonlinearity creates harmonics above the
// Nyquist frequency that fold back as inharmonic tones. Measure them.
TEST(oversampling_reduces_aliasing_of_a_hard_clipper) {
  auto clip = [](float s) { return std::max(-0.5f, std::min(0.5f, s * 4.0f)); };
  // 3.3 kHz sine: its 7th harmonic (23.1 kHz) is fine, 9th (29.7 kHz) folds to 18.3 kHz, 11th to 11.7 kHz
  const double f = 3300.0;
  const int n = 48000;
  auto spectrum_alias_db = [&](int factor) {
    Oversampler os;
    if (factor > 1) os.Init(factor);
    std::vector<float> y;
    for (int i = 0; i < n; ++i) {
      const float x = 0.5f * static_cast<float>(sin(2.0 * kPi_ * f * i / 48000.0));
      y.push_back(factor > 1 ? os.Process(x, clip) : clip(x));
    }
    // fundamental vs the folded 9th and 11th harmonics (18.3 kHz, 11.7 kHz)
    auto mag = [&](double fr) {
      double re = 0, im = 0, ws = 0;
      for (int i = 4800; i < n; ++i) {
        const double w = 0.5 - 0.5 * cos(2.0 * kPi_ * (i - 4800) / (n - 4800));
        re += w * y[i] * cos(2.0 * kPi_ * fr * i / 48000.0);
        im += w * y[i] * sin(2.0 * kPi_ * fr * i / 48000.0);
        ws += w;
      }
      return 2.0 * sqrt(re * re + im * im) / ws;
    };
    return 20.0 * log10(std::max(mag(18300.0), mag(11700.0)) / mag(f));
  };
  const double none = spectrum_alias_db(1), x2 = spectrum_alias_db(2), x4 = spectrum_alias_db(4);
  std::printf("    folded harmonics relative to the fundamental: none %.1f dB, 2x %.1f dB, 4x %.1f dB\n", none, x2, x4);
  CHECK(x2 < none - 12.0);
  CHECK(x4 < x2 - 3.0);
}

TEST(oversampler_state_is_clean_after_init) {
  Oversampler os;
  os.Init(4);
  for (int i = 0; i < 100; ++i) CHECK(os.Process(0.0f, [](float s) { return s; }) == 0.0f);
}
