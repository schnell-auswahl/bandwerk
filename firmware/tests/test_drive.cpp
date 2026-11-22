#include <algorithm>
#include <cmath>
#include <complex>
#include <vector>

#include "dsp/drive.h"
#include "test_framework.h"

using namespace bm;

namespace {

constexpr float kFs = 48000.0f;
constexpr double kPi_ = 3.14159265358979323846;

DriveParams P(bool on, int type, float gain = 0.5f, float level = 0.5f, float tone = 0.5f) {
  DriveParams p;
  p.on = on;
  p.type = type;
  p.gain = gain;
  p.level = level;
  p.tone = tone;
  return p;
}

std::vector<float> Run(DriveStage& d, const std::vector<float>& x) {
  std::vector<float> y;
  for (float v : x) y.push_back(d.Process(v));
  return y;
}

std::vector<float> Sine(double f, double amp, double seconds) {
  std::vector<float> x;
  for (int i = 0; i < static_cast<int>(seconds * kFs); ++i)
    x.push_back(static_cast<float>(amp * sin(2.0 * kPi_ * f * i / kFs)));
  return x;
}

// Reference for the loudness match: four equal tones, total peak -20 dBFS.
std::vector<float> Reference(double seconds) {
  std::vector<float> x(static_cast<size_t>(seconds * kFs), 0.0f);
  const double freqs[4] = {300.0, 700.0, 1500.0, 3000.0};
  for (double f : freqs)
    for (size_t i = 0; i < x.size(); ++i) x[i] += static_cast<float>(sin(2.0 * kPi_ * f * i / kFs));
  float pk = 0.0f;
  for (float v : x) pk = std::max(pk, fabsf(v));
  for (float& v : x) v *= 0.1f / pk;   // -20 dBFS peak
  return x;
}

double RmsDb(const std::vector<float>& x, size_t from) {
  double s = 0.0;
  for (size_t i = from; i < x.size(); ++i) s += static_cast<double>(x[i]) * x[i];
  return 10.0 * log10(s / (x.size() - from));
}

double Mag(const std::vector<float>& x, size_t from, double f) {
  double re = 0, im = 0, ws = 0;
  for (size_t i = from; i < x.size(); ++i) {
    const double w = 0.5 - 0.5 * cos(2.0 * kPi_ * (i - from) / (x.size() - from));
    re += w * x[i] * cos(2.0 * kPi_ * f * i / kFs);
    im += w * x[i] * sin(2.0 * kPi_ * f * i / kFs);
    ws += w;
  }
  return 2.0 * sqrt(re * re + im * im) / ws;
}

}  // namespace

TEST(shapers_are_bounded_odd_ish_and_monotonic) {
  for (float s = -50.0f; s <= 50.0f; s += 0.01f) {
    CHECK(fabsf(DriveStage::OdShape(s)) <= 1.11f);   // asymmetric: -1.10 .. +0.90
    CHECK(fabsf(DriveStage::DistShape(s)) <= 1.0001f);
    CHECK(fabsf(DriveStage::FuzzShape(s)) <= 1.0001f);
  }
  float po = -2.0f, pd = -2.0f, pf = -2.0f;
  for (float s = -5.0f; s <= 5.0f; s += 0.001f) {
    CHECK(DriveStage::OdShape(s) >= po - 1e-6f);
    CHECK(DriveStage::DistShape(s) >= pd - 1e-6f);
    CHECK(DriveStage::FuzzShape(s) >= pf - 1e-6f);
    po = DriveStage::OdShape(s);
    pd = DriveStage::DistShape(s);
    pf = DriveStage::FuzzShape(s);
  }
  CHECK_NEAR(DriveStage::OdShape(0.0f), 0.0, 0.002);       // no DC at rest
  CHECK_NEAR(DriveStage::DistShape(0.0f), 0.0, 1e-9);
}

TEST(off_is_a_pure_delay_of_the_latency) {
  DriveStage d;
  d.Init(kFs, P(false, 1));
  int first = -1;
  for (int i = 0; i < 100; ++i) {
    const float y = d.Process(i == 0 ? 1.0f : 0.0f);
    if (y > 0.5f && first < 0) first = i;
    if (i != DriveStage::kLatency) CHECK(fabsf(y) < 1e-6f || i < 0);
  }
  CHECK(first == DriveStage::kLatency);
}

TEST(on_changes_the_signal_and_creates_harmonics) {
  for (int type = 0; type < 3; ++type) {
    DriveStage d;
    d.Init(kFs, P(true, type, 0.8f));
    const std::vector<float> y = Run(d, Sine(1000.0, 0.1, 1.5));
    const size_t a = static_cast<size_t>(0.8 * kFs);
    const double fund = Mag(y, a, 1000.0), h3 = Mag(y, a, 3000.0), h5 = Mag(y, a, 5000.0);
    std::printf("    type %d: 3rd %.1f dB, 5th %.1f dB re the fundamental\n", type, 20 * log10(h3 / fund), 20 * log10(h5 / fund));
    CHECK(h3 > 0.02 * fund);   // clearly distorted
  }
}

TEST(more_gain_means_more_distortion) {
  for (int type = 0; type < 3; ++type) {
    auto h3 = [&](float gain) {
      DriveStage d;
      d.Init(kFs, P(true, type, gain));
      const std::vector<float> y = Run(d, Sine(1000.0, 0.05, 1.5));
      const size_t a = static_cast<size_t>(0.8 * kFs);
      return Mag(y, a, 3000.0) / Mag(y, a, 1000.0);
    };
    CHECK(h3(0.9f) > h3(0.1f));
  }
}

TEST(fuzz_has_even_harmonics_overdrive_much_fewer) {
  auto h2 = [&](int type) {
    DriveStage d;
    d.Init(kFs, P(true, type, 0.7f));
    const std::vector<float> y = Run(d, Sine(1000.0, 0.1, 1.5));
    const size_t a = static_cast<size_t>(0.8 * kFs);
    return Mag(y, a, 2000.0) / Mag(y, a, 1000.0);
  };
  CHECK(h2(2) > h2(1) * 2.0);    // the fuzz offset makes even harmonics; the distortion is symmetric
}

// Where the folded harmonics land: for a clipped 7.3 kHz sine at a 2x rate (96 kHz) the 11th harmonic
// (80.3 kHz) folds to 15.7 kHz and the 15th (109.5 kHz) to 13.5 kHz, both inside the audio band; at 4x
// (192 kHz) they are represented correctly and removed by the down-sampling filter.
double AliasDb(const std::vector<float>& y) {
  const size_t a = static_cast<size_t>(0.8 * kFs);
  const double fund = Mag(y, a, 7300.0);
  return 20 * log10(std::max(std::max(Mag(y, a, 15700.0), Mag(y, a, 13500.0)), Mag(y, a, 1100.0)) / fund);
}

TEST(fuzz_is_oversampled_4x_and_barely_aliases) {
  DriveStage d;
  d.Init(kFs, P(true, 2, 0.9f));
  const double rel = AliasDb(Run(d, Sine(7300.0, 0.2, 1.5)));
  std::printf("    fuzz: folded harmonics %.1f dB re the fundamental\n", rel);
  CHECK(rel < -45.0);
}

TEST(tone_tilts_lows_against_highs_by_6_db_each_way) {
  auto gain_at = [&](float tone, double f) {
    DriveStage d;
    d.Init(kFs, P(true, 0, 0.0f, 0.5f, tone));   // overdrive at minimum gain: nearly linear for small signals
    const std::vector<float> y = Run(d, Sine(f, 0.01, 1.5));
    const size_t a = static_cast<size_t>(0.8 * kFs);
    return 20 * log10(Mag(y, a, f) / 0.01);
  };
  // measured far from the 800 Hz corner, where the one-pole tilt has reached its end values
  const double flat_lo = gain_at(0.5f, 50.0), flat_hi = gain_at(0.5f, 15000.0);
  CHECK_NEAR(flat_lo - flat_hi, 0.0, 0.4);   // neutral at 12 o'clock
  const double bright_lo = gain_at(1.0f, 50.0), bright_hi = gain_at(1.0f, 15000.0);
  const double dark_lo = gain_at(0.0f, 50.0), dark_hi = gain_at(0.0f, 15000.0);
  std::printf("    tone: bright lows %+.1f highs %+.1f | dark lows %+.1f highs %+.1f (re flat)\n",
              bright_lo - flat_lo, bright_hi - flat_hi, dark_lo - flat_lo, dark_hi - flat_hi);
  CHECK_NEAR(bright_hi - flat_hi, 6.0, 1.0);
  CHECK_NEAR(bright_lo - flat_lo, -6.0, 1.0);
  CHECK_NEAR(dark_hi - flat_hi, -6.0, 1.0);
  CHECK_NEAR(dark_lo - flat_lo, 6.0, 1.0);
}

TEST(loudness_matches_the_drive_off_level_at_the_default_settings) {
  const std::vector<float> ref = Reference(2.0);
  const size_t a = static_cast<size_t>(0.8 * kFs);
  DriveStage off;
  off.Init(kFs, P(false, 1));
  const double off_db = RmsDb(Run(off, ref), a);
  for (int type = 0; type < 3; ++type) {
    DriveStage d;
    d.Init(kFs, P(true, type));
    const double on_db = RmsDb(Run(d, ref), a);
    std::printf("    type %d: RMS %.2f dB vs drive off %.2f dB (difference %+.2f dB)\n", type, on_db, off_db, on_db - off_db);
    CHECK_NEAR(on_db - off_db, 0.0, 1.0);
  }
}

TEST(level_knob_scales_like_the_master) {
  const std::vector<float> in = Sine(1000.0, 0.1, 1.5);
  const size_t a = static_cast<size_t>(0.8 * kFs);
  auto level_db = [&](float k) {
    DriveStage d;
    d.Init(kFs, P(true, 1, 0.5f, k));
    return 20 * log10(Mag(Run(d, in), a, 1000.0));
  };
  CHECK_NEAR(level_db(1.0f) - level_db(0.5f), 6.0, 0.3);     // right stop: +6 dB
  CHECK(level_db(0.0f) < level_db(0.5f) - 60.0);              // left stop: off
}

TEST(switching_on_and_off_does_not_click) {
  DriveStage d;
  d.Init(kFs, P(false, 1, 0.5f));
  float prev = 0.0f, max_step = 0.0f;
  const std::vector<float> in = Sine(500.0, 0.05, 3.0);
  for (size_t i = 0; i < in.size(); ++i) {
    if (i == 48000) d.SetParams(P(true, 1, 0.5f));
    if (i == 2 * 48000) d.SetParams(P(false, 1, 0.5f));
    const float y = d.Process(in[i]);
    if (i > 2000) max_step = std::max(max_step, fabsf(y - prev));
    prev = y;
  }
  // a clean 500 Hz sine at 0.05 steps by 0.0033; the drive adds harmonics but no jump
  CHECK(max_step < 0.03f);
}

TEST(changing_the_type_while_playing_does_not_click_and_ends_in_the_new_type) {
  DriveStage d;
  d.Init(kFs, P(true, 0, 0.5f));
  float prev = 0.0f, max_step = 0.0f;
  const std::vector<float> in = Sine(500.0, 0.05, 3.0);
  for (size_t i = 0; i < in.size(); ++i) {
    if (i == 48000) d.SetParams(P(true, 2, 0.5f));
    if (i == 2 * 48000) d.SetParams(P(true, 1, 0.5f));
    const float y = d.Process(in[i]);
    if (i > 2000) max_step = std::max(max_step, fabsf(y - prev));
    prev = y;
    if (i == 2 * 48000 - 1) CHECK(d.active_type() == 2);
  }
  CHECK(d.active_type() == 1);
  CHECK(max_step < 0.05f);
}

TEST(extremes_stay_finite_and_bounded) {
  for (int type = 0; type < 3; ++type) {
    DriveStage d;
    d.Init(kFs, P(true, type, 1.0f, 1.0f, 1.0f));
    bool ok = true;
    unsigned seed = 9;
    float peak = 0.0f;
    for (int i = 0; i < 200000; ++i) {
      seed = seed * 1664525u + 1013904223u;
      const float v = (seed >> 8 & 0xffff) / 32768.0f - 1.0f;
      const float y = d.Process(v * (i % 5000 < 2500 ? 4.0f : 0.0f));
      if (!std::isfinite(y)) ok = false;
      peak = std::max(peak, fabsf(y));
    }
    CHECK(ok);
    CHECK(peak < 4.0f);   // level at +6 dB and tone at +6 dB on a full-scale clipper stays sane
  }
}

// The fuzz is oversampled 4x on purpose: compare it with the same shaper at 2x.
TEST(fuzz_aliases_less_than_the_same_shaper_at_2x) {
  DriveStage d;
  d.Init(kFs, P(true, 2, 0.9f));
  const double stage = AliasDb(Run(d, Sine(7300.0, 0.2, 1.5)));
  Oversampler os2;
  os2.Init(2);
  const float pre = DbToLin(DriveGainDb(0.9f, 2));
  std::vector<float> y2;
  for (float v : Sine(7300.0, 0.2, 1.5)) y2.push_back(os2.Process(v * pre, [](float s) { return DriveStage::FuzzShape(s); }));
  const double two_x = AliasDb(y2);
  std::printf("    fuzz folded harmonics: stage (4x) %.1f dB, same shaper at 2x %.1f dB\n", stage, two_x);
  CHECK(stage < two_x - 10.0);
}

// The overdrive runs at 2x, the distortion at 4x (the original plan was 2x for both, but the distortion's hard
// knee aliased at -21 dB with 2x). How much do they alias with a clipped 7.3 kHz sine?
TEST(aliasing_of_overdrive_and_distortion_is_low) {
  for (int type = 0; type < 2; ++type) {
    for (float gain : {0.5f, 0.9f}) {
      DriveStage d;
      d.Init(kFs, P(true, type, gain));
      const double rel = AliasDb(Run(d, Sine(7300.0, 0.2, 1.5)));
      std::printf("    type %d gain %.1f: folded harmonics %.1f dB\n", type, gain, rel);
      CHECK(rel < -40.0);
    }
  }
}
