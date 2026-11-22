#include <cmath>
#include <vector>

#include "dsp/compressor.h"
#include "dsp/mapping.h"
#include "test_framework.h"

using namespace bm;

namespace {

constexpr float kFs = 48000.0f;
constexpr double kPi_ = 3.14159265358979323846;

Compressor Make(float thr, float ratio, float rel_ms, float dw, float attack_ms = 5.0f,
                float hold_ms = 0.0f) {
  Compressor c;
  CompressorSettings s;
  s.threshold_db = thr;
  s.ratio = ratio;
  s.release_ms = rel_ms;
  s.dry_wet = dw;
  c.Init(kFs, attack_ms, s, hold_ms);
  return c;
}

// Output level (dB, RMS) of a steady sine of `level_db` peak after settling.
double SineOutDb(Compressor& c, double freq, double level_db, double seconds = 1.5) {
  const double amp = pow(10.0, level_db / 20.0);
  const int n = static_cast<int>(kFs * seconds);
  double sum = 0.0;
  int count = 0;
  for (int i = 0; i < n; ++i) {
    const float y = c.Process(static_cast<float>(amp * sin(2.0 * kPi_ * freq * i / kFs)));
    if (i >= n / 2) {
      sum += static_cast<double>(y) * y;
      ++count;
    }
  }
  return 10.0 * log10(sum / count) + 3.0103;  // RMS -> peak equivalent
}

}  // namespace

TEST(static_curve_is_unity_below_the_knee_and_follows_the_ratio_above) {
  CHECK_NEAR(Compressor::StaticCurve(-60, -18, 3), -60, 1e-6);
  CHECK_NEAR(Compressor::StaticCurve(-22, -18, 3), -22, 1e-6);  // just below the knee
  CHECK_NEAR(Compressor::StaticCurve(0, -18, 3), -18 + 18.0 / 3, 1e-5);
  CHECK_NEAR(Compressor::StaticCurve(-6, -18, 8), -18 + 12.0 / 8, 1e-5);
  // continuous through both knee edges
  for (double t : {-24.0, -12.0}) {
    const double a = Compressor::StaticCurve(t - 1e-3, -18, 4);
    const double b = Compressor::StaticCurve(t + 1e-3, -18, 4);
    CHECK_NEAR(a, b, 0.01);
  }
  // monotonic
  double prev = -1e9;
  for (double x = -80; x <= 10; x += 0.25) {
    const double y = Compressor::StaticCurve(static_cast<float>(x), -24, 8);
    CHECK(y >= prev);
    prev = y;
  }
}

TEST(makeup_follows_the_spec_formula) {
  CHECK_NEAR(Compressor::MakeupDb(-18, 3), 18 * (1 - 1.0 / 3) * 0.6, 1e-5);
  CHECK_NEAR(Compressor::MakeupDb(-24, 8), 24 * (1 - 1.0 / 8) * 0.6, 1e-5);
  CHECK_NEAR(Compressor::MakeupDb(-6, 1.5), 6 * (1 - 1 / 1.5) * 0.6, 1e-5);
}

// The measured transfer curve of the real implementation matches
// StaticCurve + makeup (wet only) after the timing has settled.
TEST(steady_state_gain_matches_the_static_curve) {
  struct Case { float thr, ratio; double freq; };
  const Case cases[] = {{-18, 3, 2000}, {-24, 8, 500}, {-30, 4, 1000}, {-10, 20, 3000}};
  for (const Case& cs : cases) {
    for (double level : {-50.0, -35.0, -20.0, -10.0, -4.0}) {
      Compressor c = Make(cs.thr, cs.ratio, 150.0f, 1.0f);
      const double out = SineOutDb(c, cs.freq, level);
      const double expect = Compressor::StaticCurve(static_cast<float>(level), cs.thr, cs.ratio) +
                            Compressor::MakeupDb(cs.thr, cs.ratio);
      // the peak detector follows the waveform, so a few tenths of a dB less
      // reduction than the static curve is normal
      if (fabs(out - expect) > 0.8) {
        std::printf("    thr %.0f ratio %.0f level %.0f: out %.2f expect %.2f\n", cs.thr, cs.ratio, level, out, expect);
      }
      CHECK_NEAR(out, expect, 0.8);
    }
  }
}

// With the detector hold used for the low band (25 ms) the compression depth is
// the same for the whole bass range; without it, low notes were reduced up to
// 1.6 dB less than the curve says.
TEST(low_band_depth_is_accurate_down_to_the_lowest_note) {
  for (double f : {41.2, 55.0, 80.0, 150.0, 250.0}) {
    Compressor c = Make(-24, 8, 150, 1.0f, 10.0f, 25.0f);
    const double out = SineOutDb(c, f, -10.0, 3.0);
    const double expect = Compressor::StaticCurve(-10.0f, -24.0f, 8.0f) + Compressor::MakeupDb(-24.0f, 8.0f);
    if (fabs(out - expect) > 0.6) std::printf("    %.1f Hz: out %.2f expect %.2f\n", f, out, expect);
    CHECK_NEAR(out, expect, 0.6);
  }
  // high band, hold 5 ms
  for (double f : {250.0, 800.0, 3000.0}) {
    Compressor c = Make(-18, 3, 80, 1.0f, 5.0f, 5.0f);
    const double out = SineOutDb(c, f, -10.0, 3.0);
    const double expect = Compressor::StaticCurve(-10.0f, -18.0f, 3.0f) + Compressor::MakeupDb(-18.0f, 3.0f);
    CHECK_NEAR(out, expect, 0.5);
  }
}

TEST(dry_wet_is_a_parallel_mix) {
  Compressor dry = Make(-30, 8, 100, 0.0f);
  CHECK_NEAR(SineOutDb(dry, 1000, -10), -10, 0.02);        // untouched
  Compressor full = Make(-30, 8, 100, 1.0f);
  const double wet = SineOutDb(full, 1000, -10);
  Compressor half = Make(-30, 8, 100, 0.5f);
  const double mix = SineOutDb(half, 1000, -10);
  // level out = level in + 20 log10((1 - dw) + dw * g), g = gain of the fully wet path
  const double expect = -10.0 + 20 * log10(0.5 + 0.5 * pow(10.0, (wet + 10.0) / 20.0));
  CHECK_NEAR(mix, expect, 0.1);
  CHECK(mix > fmin(wet, -10.0) - 0.1 && mix < fmax(wet, -10.0) + 6.0);
}

TEST(detector_keeps_running_with_dry_wet_at_zero) {
  Compressor c = Make(-30, 8, 100, 0.0f);
  for (int i = 0; i < 48000; ++i) c.Process(0.3f * sinf(2.0f * 3.14159f * 1000.0f * i / kFs));
  CHECK(c.gain_reduction_db() > 5.0f);  // it measured the level although it did not apply the gain
}

TEST(attack_time_is_reached) {
  for (float attack : {5.0f, 10.0f}) {
    Compressor c = Make(-30, 8, 300, 1.0f, attack);
    // settle on silence, then a constant 0 dBFS DC-like level
    for (int i = 0; i < 4800; ++i) c.Process(0.0f);
    const float target = 0.0f - Compressor::StaticCurve(0.0f, -30, 8);
    int t63 = -1;
    for (int i = 0; i < 48000 && t63 < 0; ++i) {
      c.Process(1.0f);
      if (c.gain_reduction_db() >= 0.632f * target) t63 = i;
    }
    const double ms = 1000.0 * t63 / kFs;
    std::printf("    attack %.0f ms: gain reduction reaches 63%% after %.2f ms\n", attack, ms);
    CHECK_NEAR(ms, attack, attack * 0.25);
  }
}

TEST(release_time_is_reached) {
  for (float rel : {30.0f, 80.0f, 150.0f, 400.0f}) {
    Compressor c = Make(-30, 8, rel, 1.0f, 5.0f);
    for (int i = 0; i < 48000; ++i) c.Process(1.0f);  // fully compressed
    const float start = c.gain_reduction_db();
    int t63 = -1;
    for (int i = 0; i < 96000 && t63 < 0; ++i) {
      c.Process(0.0f);
      if (c.gain_reduction_db() <= start * (1.0f - 0.632f)) t63 = i;
    }
    const double ms = 1000.0 * t63 / kFs;
    std::printf("    release %.0f ms: gain reduction has fallen by 63%% after %.1f ms\n", rel, ms);
    CHECK_NEAR(ms, rel, rel * 0.25);
  }
}

TEST(mapping_defaults_land_where_the_spec_puts_them) {
  CHECK_NEAR(CompThresholdDb(0.0f), -40, 1e-4);
  CHECK_NEAR(CompThresholdDb(1.0f), -6, 1e-4);
  CHECK_NEAR(CompRatio(0.0f, 0), 1.5, 1e-4);
  CHECK_NEAR(CompRatio(1.0f, 0), 8.0, 1e-4);
  CHECK_NEAR(CompRatio(0.0f, 1), 4.0, 1e-4);
  CHECK_NEAR(CompRatio(1.0f, 1), 20.0, 1e-3);
  CHECK_NEAR(CompReleaseMs(0.0f, 0), 30, 1e-3);
  CHECK_NEAR(CompReleaseMs(1.0f, 0), 250, 1e-2);
  CHECK_NEAR(CompReleaseMs(0.0f, 1), 50, 1e-3);
  CHECK_NEAR(CompReleaseMs(1.0f, 1), 400, 1e-2);
  // the stored defaults of the UI (normalized) map to the factory defaults
  CHECK_NEAR(CompThresholdDb(0.647f), -18.0, 0.05);   // high
  CHECK_NEAR(CompThresholdDb(0.471f), -24.0, 0.05);   // low
  CHECK_NEAR(CompRatio(0.414f, 0), 3.0, 0.05);
  CHECK_NEAR(CompRatio(0.431f, 1), 8.0, 0.1);
  CHECK_NEAR(CompReleaseMs(0.463f, 0), 80.0, 1.0);
  CHECK_NEAR(CompReleaseMs(0.528f, 1), 150.0, 2.0);
}

TEST(silence_and_extremes_stay_finite) {
  Compressor c = Make(-18, 3, 80, 0.6f);
  bool finite = true;
  for (int i = 0; i < 100000; ++i) {
    const float x = (i % 3000 < 1500) ? 0.0f : (i % 2 ? 4.0f : -4.0f);
    if (!std::isfinite(c.Process(x))) finite = false;
  }
  CHECK(finite);
  for (int i = 0; i < 48000 * 6; ++i) c.Process(0.0f);
  CHECK(c.gain_reduction_db() == 0.0f);
}

TEST(parameter_changes_do_not_click) {
  Compressor c = Make(-18, 3, 80, 0.6f);
  CompressorSettings s;
  float prev = 0.0f, max_step = 0.0f;
  for (int i = 0; i < 96000; ++i) {
    if (i % 480 == 0) {  // sweep threshold and ratio, dry/wet
      const float k = static_cast<float>(i) / 96000.0f;
      s.threshold_db = -40.0f + 34.0f * k;
      s.ratio = 1.5f + 6.5f * k;
      s.dry_wet = k;
      s.release_ms = 30.0f + 200.0f * k;
      c.SetParams(s);
    }
    const float y = c.Process(0.2f * sinf(2.0f * 3.14159f * 200.0f * i / kFs));
    if (i > 100) max_step = fmaxf(max_step, fabsf(y - prev));
    prev = y;
  }
  CHECK(max_step < 0.08f);  // a clean 200 Hz sine at 0.2 .. makeup changes by at most ~0.05/sample
}

// Distortion of the low band compressor on a low E: fast gain changes within
// one cycle of a 41 Hz note create harmonics. Measured, not just checked.
TEST(low_note_distortion_is_measured) {
  Compressor c = Make(-24, 8, 150, 1.0f, 10.0f, 25.0f);
  const double f = 41.2;
  const double amp = pow(10.0, -8.0 / 20.0);
  const int n = static_cast<int>(kFs * 4);
  std::vector<double> y;
  for (int i = 0; i < n; ++i) {
    const double v = c.Process(static_cast<float>(amp * sin(2 * kPi_ * f * i / kFs)));
    if (i >= n / 2) y.push_back(v);
  }
  auto mag = [&](double fr) {
    double re = 0, im = 0;
    for (size_t i = 0; i < y.size(); ++i) {
      const double w = 2 * kPi_ * fr * i / kFs;
      re += y[i] * cos(w);
      im += y[i] * sin(w);
    }
    return 2.0 * sqrt(re * re + im * im) / y.size();
  };
  const double fund = mag(f);
  double harm2 = 0.0;
  for (int h = 2; h <= 6; ++h) harm2 += mag(f * h) * mag(f * h);
  const double thd_db = 10 * log10(harm2) - 20 * log10(fund);
  std::printf("    41 Hz at -8 dBFS, 8:1, 10 ms attack, 150 ms release, 25 ms hold: harmonics %.1f dB below the fundamental\n", thd_db);
  CHECK(thd_db < -40.0);
}
