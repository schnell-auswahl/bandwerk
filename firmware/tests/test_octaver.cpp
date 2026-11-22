#include <algorithm>
#include <cmath>
#include <vector>

#include "dsp/octaver.h"
#include "test_framework.h"

using namespace bm;

namespace {

constexpr float kFs = 48000.0f;
constexpr double kPi_ = 3.14159265358979323846;

struct Result {
  std::vector<float> sub, up, in;
  std::vector<float> pitch;  // detected pitch per sample
};

// A bass-like note: a sum of harmonics (amplitudes a[0] for the fundamental ...).
float Note(double f, double t, const std::vector<double>& a) {
  double v = 0.0;
  for (size_t h = 0; h < a.size(); ++h) v += a[h] * sin(2.0 * kPi_ * f * (h + 1) * t);
  return static_cast<float>(v);
}

Result Run(Octaver& o, const std::vector<float>& x) {
  Result r;
  r.in = x;
  for (float v : x) {
    float s, u;
    o.Process(v, &s, &u);
    r.sub.push_back(s);
    r.up.push_back(u);
    r.pitch.push_back(o.pitch_hz());
  }
  return r;
}

std::vector<float> MakeNote(double f, double peak, const std::vector<double>& a, double seconds) {
  std::vector<float> x;
  double norm = 0.0;
  for (double v : a) norm += fabs(v);
  for (int i = 0; i < static_cast<int>(seconds * kFs); ++i)
    x.push_back(static_cast<float>(peak / norm * Note(f, i / kFs, a)));
  // the norm above is a safe bound; rescale to the true peak
  float pk = 0.0f;
  for (float v : x) pk = std::max(pk, fabsf(v));
  for (float& v : x) v = static_cast<float>(v * peak / pk);
  return x;
}

// Amplitude of the component at `freq` in x[from, to) (single-bin DFT).
double Mag(const std::vector<float>& x, size_t from, size_t to, double freq) {
  double re = 0, im = 0;
  for (size_t i = from; i < to; ++i) {
    const double w = 2.0 * kPi_ * freq * i / kFs;
    re += x[i] * cos(w);
    im += x[i] * sin(w);
  }
  return 2.0 * sqrt(re * re + im * im) / (to - from);
}

double Db(double v) { return 20.0 * log10(std::max(v, 1e-12)); }

double Median(std::vector<float> v) {
  std::sort(v.begin(), v.end());
  return v.empty() ? 0.0 : v[v.size() / 2];
}

}  // namespace

TEST(minus_one_octave_is_half_the_frequency_for_sines) {
  for (double f : {41.2, 55.0, 82.4, 110.0, 164.8, 220.0}) {
    Octaver o;
    o.Init(kFs);
    Result r = Run(o, MakeNote(f, 0.3, {1.0}, 2.0));
    const size_t a = static_cast<size_t>(1.2 * kFs), b = r.sub.size();
    const double at_half = Mag(r.sub, a, b, f / 2), at_f = Mag(r.sub, a, b, f), in_f = Mag(r.in, a, b, f);
    std::printf("    %6.1f Hz: sub at f/2 %.1f dB re input, at f %.1f dB, pitch %.1f Hz\n", f,
                Db(at_half / in_f), Db(at_f / in_f), Median(std::vector<float>(r.pitch.begin() + a, r.pitch.end())));
    CHECK(at_half > 3.0 * at_f);                  // dominated by f/2
    CHECK_NEAR(Db(at_half / in_f), 0.0, 4.0);     // about as loud as the original
  }
}

// A bass note often has a 2nd harmonic as strong as the fundamental. The
// detector must still find the fundamental (the sub is then at f/2, not at f).
TEST(tracking_survives_strong_second_harmonics) {
  const std::vector<std::vector<double>> shapes = {
      {1.0, 0.6, 0.35, 0.2},          // fundamental dominant
      {0.8, 1.0, 0.5, 0.3, 0.2},      // 2nd harmonic slightly stronger
      {0.6, 1.0, 0.7, 0.4, 0.3, 0.2}, // 2nd harmonic clearly stronger
  };
  for (size_t s = 0; s < shapes.size(); ++s) {
    for (double f : {41.2, 55.0, 73.4, 98.0, 130.8}) {
      Octaver o;
      o.Init(kFs);
      Result r = Run(o, MakeNote(f, 0.4, shapes[s], 2.0));
      const size_t a = static_cast<size_t>(1.2 * kFs), b = r.sub.size();
      const double p = Median(std::vector<float>(r.pitch.begin() + a, r.pitch.end()));
      const double half = Mag(r.sub, a, b, f / 2), whole = Mag(r.sub, a, b, f);
      const bool right = fabs(p - f) < 0.03 * f && half > whole;
      std::printf("    shape %zu %6.1f Hz: tracked %6.1f Hz, sub f/2 %.4f vs f %.4f %s\n", s, f, p, half, whole,
                  right ? "" : "  <-- WRONG");
      CHECK(right);
    }
  }
}

TEST(a_decaying_pluck_gives_a_decaying_sub_and_silence_at_the_end) {
  Octaver o;
  o.Init(kFs);
  std::vector<float> x;
  const double f = 55.0;
  for (int i = 0; i < static_cast<int>(3.0 * kFs); ++i) {
    const double t = i / kFs;
    x.push_back(static_cast<float>(0.5 * exp(-t * 2.2) * Note(f, t, {1.0, 0.7, 0.4}) / 1.6));
  }
  Result r = Run(o, x);
  auto peak = [&](double t0, double t1) {
    float m = 0;
    for (size_t i = static_cast<size_t>(t0 * kFs); i < static_cast<size_t>(t1 * kFs); ++i) m = std::max(m, fabsf(r.sub[i]));
    return m;
  };
  const float early = peak(0.2, 0.4), mid = peak(1.0, 1.2), late = peak(2.8, 3.0);
  std::printf("    sub peaks: early %.4f mid %.4f late %.5f\n", early, mid, late);
  CHECK(early > mid && mid > late);
  CHECK(early > 0.05f);
  CHECK(late < 0.003f);  // the note faded below the gate: nothing chatters on
}

TEST(noise_without_a_note_stays_silent) {
  Octaver o;
  o.Init(kFs);
  std::vector<float> x;
  unsigned seed = 5;
  for (int i = 0; i < static_cast<int>(3.0 * kFs); ++i) {
    seed = seed * 1664525u + 1013904223u;
    x.push_back(((seed >> 8 & 0xffff) / 32768.0f - 1.0f) * 0.0006f);  // about -64 dBFS peak
  }
  Result r = Run(o, x);
  float m = 0, mu = 0;
  for (size_t i = static_cast<size_t>(0.5 * kFs); i < r.sub.size(); ++i) {
    m = std::max(m, fabsf(r.sub[i]));
    mu = std::max(mu, fabsf(r.up[i]));
  }
  CHECK(m < 1.0e-4f);
  CHECK(mu < 1.0e-4f);
  CHECK(!o.gate_open());
}

TEST(plus_one_octave_is_double_the_frequency_for_sines) {
  for (double f : {110.0, 165.0, 220.0, 330.0}) {
    Octaver o;
    o.Init(kFs);
    Result r = Run(o, MakeNote(f, 0.3, {1.0}, 1.5));
    const size_t a = static_cast<size_t>(0.8 * kFs), b = r.up.size();
    const double at_2f = Mag(r.up, a, b, 2 * f), at_f = Mag(r.up, a, b, f), in_f = Mag(r.in, a, b, f);
    double mean = 0;
    for (size_t i = a; i < b; ++i) mean += r.up[i];
    mean /= (b - a);
    std::printf("    %6.1f Hz: up at 2f %.1f dB re input, at f %.1f dB, DC %.5f\n", f, Db(at_2f / in_f), Db(at_f / in_f), mean);
    CHECK(at_2f > 4.0 * at_f);
    CHECK_NEAR(Db(at_2f / in_f), 0.0, 3.0);
    CHECK(fabs(mean) < 0.002);
  }
}

TEST(tracking_follows_a_note_change_quickly) {
  Octaver o;
  o.Init(kFs);
  std::vector<float> x = MakeNote(55.0, 0.4, {1.0, 0.6, 0.3}, 1.0);
  const std::vector<float> y = MakeNote(73.4, 0.4, {1.0, 0.6, 0.3}, 1.0);
  x.insert(x.end(), y.begin(), y.end());
  Result r = Run(o, x);
  const size_t change = static_cast<size_t>(1.0 * kFs);
  const double before = Median(std::vector<float>(r.pitch.begin() + change - 4800, r.pitch.begin() + change));
  const double after_100ms = Median(std::vector<float>(r.pitch.begin() + change + 4800, r.pitch.begin() + change + 7200));
  std::printf("    55 Hz -> 73.4 Hz: before %.1f Hz, 100-150 ms after %.1f Hz\n", before, after_100ms);
  CHECK_NEAR(before, 55.0, 2.0);
  CHECK_NEAR(after_100ms, 73.4, 2.5);
}

TEST(sub_tone_sets_the_low_pass_of_the_sub) {
  // a higher cutoff lets more of the square's harmonics through: more energy at 3 x f/2
  auto third = [&](float hz) {
    Octaver o;
    o.Init(kFs, hz);
    Result r = Run(o, MakeNote(110.0, 0.3, {1.0}, 2.0));
    const size_t a = static_cast<size_t>(1.2 * kFs), b = r.sub.size();
    return Mag(r.sub, a, b, 165.0) / Mag(r.sub, a, b, 55.0);
  };
  CHECK(third(500.0f) > 2.0 * third(80.0f));
}

TEST(extreme_input_stays_finite) {
  Octaver o;
  o.Init(kFs);
  bool finite = true;
  unsigned seed = 3;
  for (int i = 0; i < 200000; ++i) {
    seed = seed * 1664525u + 1013904223u;
    const float v = (i % 40000 < 20000) ? ((seed >> 8 & 0xffff) / 32768.0f - 1.0f) * 3.0f : 0.0f;
    float s, u;
    o.Process(v, &s, &u);
    if (!std::isfinite(s) || !std::isfinite(u)) finite = false;
  }
  CHECK(finite);
}
