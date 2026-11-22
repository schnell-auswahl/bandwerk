// FX loop (M4): latency delay, measuring probe and the loop block in the chain.
#include <cmath>
#include <vector>

#include "dsp/bass_chain.h"
#include "dsp/loop_delay.h"
#include "dsp/loop_probe.h"
#include "test_framework.h"

using namespace bm;

namespace {
constexpr float kFs = 48000.0f;
constexpr double kTestPi = 3.14159265358979;

ChainParams NoComp() {
  ChainParams p;
  p.comp[0].dry_wet = 0.0f;
  p.comp[1].dry_wet = 0.0f;
  return p;
}

// Level (dB re amplitude 1) of `f` in y[a, b) by correlation with sin/cos.
double ToneDb(const std::vector<float>& y, size_t a, size_t b, double f) {
  double s = 0.0, c = 0.0;
  for (size_t n = a; n < b; ++n) {
    s += y[n] * sin(2.0 * kTestPi * f * n / kFs);
    c += y[n] * cos(2.0 * kTestPi * f * n / kFs);
  }
  const double amp = 2.0 * sqrt(s * s + c * c) / static_cast<double>(b - a);
  return 20.0 * log10(amp + 1e-15);
}

// Runs the chain with a simulated external loop: the return is the send,
// `loop_delay` samples later (fractional, same interpolation as the pedal),
// times `loop_gain`.
struct LoopRig {
  BassChain chain;
  LoopDelay loop;
  std::vector<float> sends;
  float loop_gain;
  float prev_send = 0.0f;
  LoopRig(const ChainParams& p, float delay, float gain = 1.0f) : loop_gain(gain) {
    chain.Init(kFs, p);
    // The send of this sample reaches the loop on the next call (one sample),
    // so the model delays by one sample less.
    loop.Init(kFs, delay - 1.0f);
  }
  float Step(float x) {
    const float ret = loop_gain * loop.Process(prev_send);
    float send = 0.0f;
    const float y = chain.Process(x, ret, &send);
    sends.push_back(send);
    prev_send = send;
    return y;
  }
};

// Output level of a sine through the chain with the simulated loop.
double ChainToneDb(const ChainParams& p, float loop_delay, double f, float amp = 0.1f) {
  LoopRig r(p, loop_delay);
  const size_t n = static_cast<size_t>(0.6 * kFs);
  std::vector<float> y(n);
  for (size_t i = 0; i < n; ++i) y[i] = r.Step(amp * static_cast<float>(sin(2.0 * kTestPi * f * i / kFs)));
  return ToneDb(y, static_cast<size_t>(0.3 * kFs), n, f) - 20.0 * log10(amp);
}

const float kRt = kLoopRoundTripSamples;
}  // namespace

// ---------- LoopDelay ----------

TEST(loop_delay_zero_is_exact_and_integer_delay_is_exact) {
  LoopDelay d0, d5;
  d0.Init(kFs, 0.0f);
  d5.Init(kFs, 5.0f);
  std::vector<float> x(200);
  for (size_t i = 0; i < x.size(); ++i) x[i] = static_cast<float>(sin(0.1 * i) + 0.01 * i);
  bool ok0 = true, ok5 = true;
  for (size_t i = 0; i < x.size(); ++i) {
    ok0 = ok0 && d0.Process(x[i]) == x[i];
    const float y = d5.Process(x[i]);
    if (i >= 5) ok5 = ok5 && y == x[i - 5];
  }
  CHECK(ok0);
  CHECK(ok5);
}

TEST(loop_delay_cubic_interpolation_keeps_the_highs) {
  // 10 kHz through a delay of 42.81 samples: 0.3 dB loss (linear would be 1.1 dB)
  LoopDelay d;
  d.Init(kFs, 42.81f);
  const double f = 10000.0;
  std::vector<float> y(9600);
  for (size_t i = 0; i < y.size(); ++i) y[i] = d.Process(static_cast<float>(sin(2.0 * kTestPi * f * i / kFs)));
  const double db = ToneDb(y, 4800, y.size(), f);
  std::printf("    10 kHz through 42.81 samples: %+.3f dB\n", db);
  CHECK(db > -0.4 && db < 0.05);
}

TEST(loop_delay_fractional_delay_matches_a_low_sine) {
  LoopDelay d;
  d.Init(kFs, 10.5f);
  double worst = 0.0;
  const double f = 200.0;
  for (int i = 0; i < 4800; ++i) {
    const float y = d.Process(static_cast<float>(sin(2.0 * kTestPi * f * i / kFs)));
    if (i > 100) worst = fmax(worst, fabs(y - sin(2.0 * kTestPi * f * (i - 10.5) / kFs)));
  }
  CHECK(worst < 1e-3);  // linear interpolation error at 200 Hz is tiny
}

TEST(loop_delay_large_jump_crossfades_without_a_click) {
  LoopDelay d;
  d.Init(kFs, 0.0f);
  const double f = 1000.0;
  float prev = 0.0f;
  double max_step = 0.0, steady_step = 0.0;
  for (int i = 0; i < 9600; ++i) {
    if (i == 4800) d.SetTarget(34.0f);
    const float y = d.Process(static_cast<float>(sin(2.0 * kTestPi * f * i / kFs)));
    const double step = fabs(y - prev);
    if (i > 10 && i < 4800) steady_step = fmax(steady_step, step);
    if (i >= 4800) max_step = fmax(max_step, step);
    prev = y;
  }
  CHECK(max_step <= steady_step * 1.05);  // never steeper than the sine itself
  CHECK(d.delay() == 34.0f);
}

TEST(loop_delay_two_instances_stay_in_step) {
  LoopDelay a, b;
  a.Init(kFs, 0.0f);
  b.Init(kFs, 0.0f);
  bool same = true;
  for (int i = 0; i < 20000; ++i) {
    const float t = (i / 1500) % 2 ? 34.0f + 0.3f * (i % 7) : 0.0f;
    a.SetTarget(t);
    b.SetTarget(t);
    const float x = static_cast<float>(sin(0.05 * i));
    same = same && a.Process(x) == b.Process(x);
  }
  CHECK(same);
}

// ---------- LoopProbe ----------

namespace {
// Runs the probe through a loop model: return = f(send delayed by `lag`).
template <class F>
LoopProbeResult Probe(float lag, F shape, float noise = 0.0f) {
  LoopProbe p;
  LoopDelay d;
  d.Init(kFs, lag);
  p.Start();
  float send = 0.0f;
  unsigned seed = 7;
  while (p.running()) {
    seed = seed * 1664525u + 1013904223u;
    const float n = noise * ((seed >> 8 & 0xffff) / 32768.0f - 1.0f);
    const float ret = shape(d.Process(send)) + n;
    send = p.Process(ret);
  }
  // The model above feeds back with one extra sample (the send of this call
  // reaches the delay on the next call), so the lag found is lag + 1.
  return p.Analyze();
}
}  // namespace

TEST(probe_finds_integer_and_fractional_lag_gain_and_polarity) {
  const LoopProbeResult a = Probe(34.0f, [](float v) { return v; });
  CHECK(a.found);
  CHECK_NEAR(a.lag, 35.0, 0.05);
  CHECK_NEAR(a.gain_db, 0.0, 0.1);
  CHECK(!a.inverted);
  const LoopProbeResult b = Probe(120.0f, [](float v) { return -0.5f * v; });
  CHECK(b.found);
  CHECK_NEAR(b.lag, 121.0, 0.05);
  CHECK_NEAR(b.gain_db, -6.0, 0.1);
  CHECK(b.inverted);
  // Fractional lag (the linear interpolation of the model smears white noise a bit).
  const LoopProbeResult c = Probe(60.4f, [](float v) { return v; });
  CHECK(c.found);
  CHECK_NEAR(c.lag, 61.4, 0.25);
  std::printf("    lag 34 -> %.2f, 120 -> %.2f, 60.4 -> %.2f (each +1 from the model)\n", a.lag, b.lag, c.lag);
}

TEST(probe_works_through_a_distorting_effect) {
  const LoopProbeResult r = Probe(250.0f, [](float v) { return tanhf(8.0f * v); });
  CHECK(r.found);
  CHECK_NEAR(r.lag, 251.0, 0.5);
  std::printf("    through tanh(8x): coef %.2f, gain %+.1f dB\n", r.coef, r.gain_db);
}

TEST(probe_reports_nothing_when_the_return_is_not_connected) {
  const LoopProbeResult r = Probe(34.0f, [](float) { return 0.0f; }, 0.001f);
  CHECK(!r.found);
  CHECK(r.return_rms_db < -55.0f);
  const LoopProbeResult silent = Probe(34.0f, [](float) { return 0.0f; });
  CHECK(!silent.found);
}

// ---------- the loop block in the chain ----------

TEST(bridge_mutes_the_send_and_ignores_the_return) {
  ChainParams p = NoComp();
  BassChain a, b;
  a.Init(kFs, p);
  b.Init(kFs, p);
  bool same = true, silent = true;
  for (int i = 0; i < 20000; ++i) {
    const float x = 0.2f * static_cast<float>(sin(0.03 * i));
    float send = 1.0f;
    const float ya = a.Process(x);
    const float yb = b.Process(x, 0.5f * static_cast<float>(sin(0.7 * i)), &send);
    same = same && ya == yb;
    silent = silent && send == 0.0f;
  }
  CHECK(same);
  CHECK(silent);
}

TEST(ideal_loop_keeps_the_band_sum_flat_at_800_hz) {
  ChainParams bridge = NoComp();
  bridge.crossover = 1.0f;  // 800 Hz: a time offset between the bands shows most here
  ChainParams loop = bridge;
  loop.loop_mode = 1;
  for (double f : {400.0, 560.0, 800.0, 1100.0, 2000.0}) {
    const double b = ChainToneDb(bridge, 0, f);
    const double l = ChainToneDb(loop, kRt, f);
    std::printf("    %6.0f Hz: bridge %+.3f dB, loop %+.3f dB\n", f, b, l);
    CHECK_NEAR(l, b, 0.1);
  }
}

TEST(extra_effect_latency_breaks_the_sum_and_the_measured_latency_fixes_it) {
  ChainParams loop = NoComp();
  loop.crossover = 1.0f;
  loop.loop_mode = 1;
  const float extra = 24.0f;  // 0.5 ms in the external effect
  const double bad = ChainToneDb(loop, kRt + extra, 800.0);
  loop.loop_latency = kRt + extra;  // what the automatic measurement sets
  const double fixed = ChainToneDb(loop, kRt + extra, 800.0);
  // The fine trim reaches the same from the old constant: +0.5 ms = 3/4 of the right half.
  ChainParams trimmed = NoComp();
  trimmed.crossover = 1.0f;
  trimmed.loop_mode = 1;
  trimmed.loop_trim = 0.5f + 0.02f + 0.5f * (0.5f - 0.02f);
  const double by_trim = ChainToneDb(trimmed, kRt + extra, 800.0);
  std::printf("    800 Hz with +0.5 ms in the loop: %+.2f dB, measured %+.2f dB, by fine trim %+.2f dB\n",
              bad, fixed, by_trim);
  CHECK(bad < -1.0);
  CHECK_NEAR(fixed, 0.0, 0.2);
  CHECK_NEAR(by_trim, 0.0, 0.2);
}

TEST(fine_trim_moves_the_delay_around_the_measured_latency) {
  ChainParams p = NoComp();
  p.loop_mode = 1;
  p.loop_latency = 171.0f;
  // with mix 50 % a dry/return offset makes a comb: a 1 kHz notch needs 0.5 ms (24 samples)
  p.loop_mix = 0.5f;
  const double aligned = ChainToneDb(p, 171.0f, 1000.0);
  p.loop_trim = 1.0f;  // +1 ms: the dry path is now 48 samples late = notches at 500 / 1500 Hz (500 Hz is too close to the crossover to be clean)
  const double plus1 = ChainToneDb(p, 171.0f, 1500.0);
  std::printf("    latency 171: aligned 1 kHz %+.2f dB, trim +1 ms at 1.5 kHz %+.1f dB\n", aligned, plus1);
  CHECK_NEAR(aligned, 0.0, 0.1);
  CHECK(plus1 < -30.0);
}

TEST(mix_half_is_flat_and_phase_invert_cancels_the_high_band) {
  ChainParams p = NoComp();
  p.loop_mode = 1;
  p.loop_mix = 0.5f;
  const double normal = ChainToneDb(p, kRt, 3000.0);
  p.loop_mode = 2;
  const double inverted = ChainToneDb(p, kRt, 3000.0);
  std::printf("    3 kHz, mix 50 %%: normal %+.2f dB, inverted %+.1f dB\n", normal, inverted);
  CHECK_NEAR(normal, 0.0, 0.1);
  CHECK(inverted < -60.0);
}

TEST(mix_zero_is_the_dry_path_and_mix_one_is_only_the_return) {
  ChainParams p = NoComp();
  p.loop_mode = 1;
  p.loop_mix = 0.0f;
  LoopRig open(p, kRt, 0.0f);  // nothing comes back
  std::vector<float> y(28800);
  for (size_t i = 0; i < y.size(); ++i) y[i] = open.Step(0.1f * static_cast<float>(sin(2.0 * kTestPi * 3000.0 * i / kFs)));
  CHECK_NEAR(ToneDb(y, 14400, y.size(), 3000.0), -20.0, 0.1);  // dry only
  p.loop_mix = 1.0f;
  LoopRig open2(p, kRt, 0.0f);
  for (size_t i = 0; i < y.size(); ++i) y[i] = open2.Step(0.1f * static_cast<float>(sin(2.0 * kTestPi * 3000.0 * i / kFs)));
  CHECK(ToneDb(y, 14400, y.size(), 3000.0) < -80.0);  // high band only from the return
}

TEST(send_and_return_levels_span_plus_minus_12_db) {
  ChainParams p = NoComp();
  p.loop_mode = 1;
  auto send_db = [&](float k) {
    p.loop_send = k;
    LoopRig r(p, kRt);
    std::vector<float> s;
    for (int i = 0; i < 28800; ++i) r.Step(0.05f * static_cast<float>(sin(2.0 * kTestPi * 3000.0 * i / kFs)));
    return ToneDb(r.sends, 14400, r.sends.size(), 3000.0) - 20.0 * log10(0.05);
  };
  CHECK_NEAR(send_db(0.5f), 0.0, 0.1);
  CHECK_NEAR(send_db(1.0f), 12.0, 0.1);
  CHECK_NEAR(send_db(0.0f), -12.0, 0.1);
  p.loop_send = 0.5f;
  p.loop_return = 1.0f;
  CHECK_NEAR(ChainToneDb(p, kRt, 3000.0, 0.02f), 12.0, 0.1);
  p.loop_return = 0.0f;
  CHECK_NEAR(ChainToneDb(p, kRt, 3000.0, 0.02f), -12.0, 0.1);
}

TEST(switching_bridge_to_loop_and_back_does_not_click) {
  ChainParams bridge = NoComp();
  ChainParams loop = bridge;
  loop.loop_mode = 1;
  LoopRig r(bridge, kRt);
  float prev = 0.0f;
  double steady = 0.0, during = 0.0;
  for (int i = 0; i < 96000; ++i) {
    if (i == 24000) r.chain.SetParams(loop);
    if (i == 60000) r.chain.SetParams(bridge);
    const float y = r.Step(0.2f * static_cast<float>(sin(2.0 * kTestPi * 440.0 * i / kFs)));
    const double step = fabs(y - prev);
    if (i > 12000 && i < 24000) steady = fmax(steady, step);
    if (i >= 24000) during = fmax(during, step);
    prev = y;
  }
  std::printf("    largest sample step: steady %.4f, while switching %.4f\n", steady, during);
  CHECK(during < steady * 1.3);
}

TEST(loop_fine_trim_is_plus_minus_1_ms_with_a_center_dead_band) {
  CHECK_NEAR(LoopFineMs(0.0f), -1.0, 1e-6);
  CHECK_NEAR(LoopFineMs(0.49f), 0.0, 1e-6);
  CHECK_NEAR(LoopFineMs(0.5f), 0.0, 1e-6);
  CHECK_NEAR(LoopFineMs(0.51f), 0.0, 1e-6);
  CHECK_NEAR(LoopFineMs(1.0f), 1.0, 1e-6);
  CHECK(LoopFineMs(0.6f) > 0.0f && LoopFineMs(0.4f) < 0.0f);
  CHECK_NEAR(LoopLevelDb(0.5f), 0.0, 1e-6);
}
