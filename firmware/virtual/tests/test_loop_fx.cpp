// The virtual effect pedals in the FX loop and the loop latency measurement
// through them: the demo's point (docs/VIRTUAL.md).
#include "test_response.h"

using namespace vt;
using bm::virt::LoopFxPedal;

namespace {

constexpr double kMs = Rig::kSr / 1000.0;  // samples per millisecond

// A clean measurement setup: compressors out of the way, a high crossover so
// that the two bands overlap where the comb would show.
void Setup(Rig& r, FxType type, bool on) {
  r.Cmd("set ch_dw 0");
  r.Cmd("set cl_dw 0");
  r.Cmd("set xover 900");
  FxConfig c;
  c.type = type;
  c.on = on;
  r.p->SetLoopFx(c);
}

double MeasuredMs(FxType type, bool on, float p0 = 0.5f, float p1 = 0.5f, float p2 = 0.5f) {
  Rig r;
  Setup(r, type, on);
  FxConfig c;
  c.type = type;
  c.on = on;
  c.p[0] = p0;
  c.p[1] = p1;
  c.p[2] = p2;
  r.p->SetLoopFx(c);
  r.Seconds(0.3f);
  ReMeasure(r);
  const int lag = WaitForLoopResult(r);
  return lag < 0 ? -1.0 : lag / 100.0 / kMs;
}

}  // namespace

TEST(the_pedals_report_their_latency) {
  LoopFxPedal fx;
  fx.Init(48000.0f);
  CHECK_NEAR(fx.latency_samples(), 48.0, 1e-4);
  bm::virt::FxConfig c;
  c.type = FxType::kChorus;
  fx.Configure(c);
  CHECK_NEAR(fx.latency_samples(), 86.4, 1e-3);
}

TEST(an_impulse_comes_back_after_exactly_the_latency_minus_the_wire_sample) {
  // VirtualPedal adds one sample for the wire OUT R -> IN R, so the pedal's own
  // delay is latency - 1: the overdrive is off, the impulse is a copy delayed by 47 samples.
  LoopFxPedal fx;
  fx.Init(48000.0f);
  int at = -1;
  float peak = 0.0f;
  for (int i = 0; i < 400; ++i) {
    const float y = fx.Process(i == 0 ? 1.0f : 0.0f);
    if (std::fabs(y) > peak) {
      peak = std::fabs(y);
      at = i;
    }
  }
  CHECK(at == 47);
  CHECK_NEAR(peak, 1.0, 1e-6);
}

TEST(the_chorus_keeps_its_latency_on_and_off) {
  for (int on = 0; on < 2; ++on) {
    LoopFxPedal fx;
    fx.Init(48000.0f);
    bm::virt::FxConfig c;
    c.type = FxType::kChorus;
    c.on = on != 0;
    c.p[2] = 0.0f;  // mix 0: only the dry path
    fx.Configure(c);
    for (int i = 0; i < 30000; ++i) fx.Process(0.0f);  // let the crossfades and smoothers settle
    double sum = 0.0, wsum = 0.0;
    for (int i = 0; i < 400; ++i) {
      const float y = fx.Process(i == 0 ? 1.0f : 0.0f);
      sum += std::fabs(y);
      wsum += std::fabs(y) * i;
    }
    CHECK_NEAR(wsum / sum, 85.4, 0.3);  // 86.4 - 1
  }
}

TEST(the_overdrive_clips_softly_and_stays_symmetric) {
  LoopFxPedal fx;
  fx.Init(48000.0f);
  bm::virt::FxConfig c;
  c.on = true;
  c.p[0] = 1.0f;  // full drive
  c.p[1] = 1.0f;
  c.p[2] = 0.5f;
  fx.Configure(c);
  float pos = 0.0f, neg = 0.0f, quiet_peak = 0.0f;
  for (int i = 0; i < 48000; ++i) {
    const float x = 0.5f * std::sin(0.0654f * static_cast<float>(i));
    const float y = fx.Process(x);
    if (i > 24000) {
      pos = std::fmax(pos, y);
      neg = std::fmin(neg, y);
    }
  }
  CHECK(pos > 0.05f && pos < 1.5f);
  CHECK_NEAR(pos, -neg, 0.02 * pos);
  // low drive stays clean-ish: output scales with input
  c.p[0] = 0.0f;
  fx.Configure(c);
  for (int i = 0; i < 4800; ++i) fx.Process(0.0f);
  for (int i = 0; i < 24000; ++i) {
    const float y = fx.Process(0.01f * std::sin(0.0654f * static_cast<float>(i)));
    if (i > 12000) quiet_peak = std::fmax(quiet_peak, std::fabs(y));
  }
  CHECK(quiet_peak > 0.003f);
}

TEST(the_loop_measurement_finds_one_millisecond_through_the_overdrive) {
  for (int on = 0; on < 2; ++on) {
    const double ms = MeasuredMs(FxType::kOverdrive, on != 0);
    CHECK(ms > 0.0);
    CHECK_NEAR(ms, 1.0, 0.02);
  }
}

TEST(the_loop_measurement_finds_one_point_eight_milliseconds_through_the_chorus) {
  for (int on = 0; on < 2; ++on) {
    const double ms = MeasuredMs(FxType::kChorus, on != 0);
    CHECK(ms > 0.0);
    CHECK_NEAR(ms, 1.8, 0.02);
  }
}

TEST(the_measurement_finds_the_latency_at_every_pedal_setting) {
  for (float drive : {0.0f, 1.0f})
    for (float tone : {0.0f, 1.0f}) CHECK_NEAR(MeasuredMs(FxType::kOverdrive, true, drive, tone, 0.5f), 1.0, 0.03);
  // the dry signal stays the strongest part of the chorus, so the delayed copy never wins
  for (float depth : {0.0f, 1.0f}) CHECK_NEAR(MeasuredMs(FxType::kChorus, true, 0.35f, depth, 1.0f), 1.8, 0.03);
}

TEST(the_chain_is_flat_when_the_loop_is_aligned) {
  Rig bridge;
  Setup(bridge, FxType::kOverdrive, false);
  const Response flat = MeasureResponse(bridge);
  const double ref = flat.BandDb(100, 4000);
  CHECK_NEAR(ref, 0.0, 0.2);

  for (FxType t : {FxType::kOverdrive, FxType::kChorus}) {
    Rig r;
    Setup(r, t, false);
    r.Seconds(0.3f);
    ReMeasure(r);
    CHECK(WaitForLoopResult(r) > 0);
    r.Seconds(0.3f);
    const Response resp = MeasureResponse(r);
    CHECK(std::fabs(resp.MaxDip(60, 3000, ref)) < 0.5);
  }
}

TEST(switching_pedals_without_measuring_again_makes_a_comb_and_measuring_fixes_it) {
  Rig r;
  Setup(r, FxType::kOverdrive, false);
  r.Seconds(0.3f);
  ReMeasure(r);
  CHECK(WaitForLoopResult(r) > 0);
  const double ref = MeasureResponse(r).BandDb(100, 4000);

  // the chorus has 0.8 ms more latency, but the pedal still compensates 1.0 ms
  FxConfig c;
  c.type = FxType::kChorus;
  c.on = false;
  r.p->SetLoopFx(c);
  r.Seconds(0.3f);
  const Response comb = MeasureResponse(r);
  CHECK(comb.MaxDip(60, 3000, ref) < -10.0);  // a deep notch in the crossover region
  // ... near the frequency where 0.8 ms is half a period (625 Hz)
  CHECK(comb.BandDb(550, 700) - ref < -10.0);

  // flipping S2 Bridge -> Loop measures again
  ReMeasure(r);
  CHECK(WaitForLoopResult(r) > 0);
  r.Seconds(0.3f);
  const Response fixed = MeasureResponse(r);
  CHECK(std::fabs(fixed.MaxDip(60, 3000, ref)) < 0.5);
}

TEST(the_chain_runs_bridged_while_measuring_then_uses_the_result) {
  Rig r;
  Setup(r, FxType::kOverdrive, false);
  r.Seconds(0.3f);
  r.Cmd("lmode loop");  // remote: measures like the switch does
  r.Seconds(0.1f);
  CHECK(r.p->loop_measuring());
  CHECK(Field(r.Last("[M]"), "el") == 0);  // the chain plays the high band dry meanwhile
  CHECK(WaitForLoopResult(r) > 0);
  r.Seconds(0.3f);
  CHECK(Field(r.Last("[M]"), "el") == 1);
  CHECK_NEAR(Field(r.Last("[M]"), "dl"), 4800, 5);
  r.Seconds(1.0f);
  const std::string sys = r.Last("[SYS]");
  CHECK_NEAR(Field(sys, "lat"), 4800, 5);
  CHECK(Field(sys, "ltry") == 1);
  CHECK(Field(sys, "lres") == 1);
}

TEST(the_loop_signal_reaches_the_output_and_bypass_mutes_the_send) {
  Rig r;
  Setup(r, FxType::kOverdrive, true);
  r.Seconds(0.3f);
  ReMeasure(r);
  CHECK(WaitForLoopResult(r) > 0);
  r.lines.clear();
  r.Run(48000, [](int i) { return 0.3f * std::sin(0.05f * static_cast<float>(i)); });
  const std::string m = r.Last("[M]");
  CHECK(Field(m, "sd") > -400);  // there is a send ...
  CHECK(Field(m, "rt") > -400);  // ... and a return
  CHECK(Field(m, "el") == 1);
  r.Cmd("byp on");
  r.Run(4800, [](int i) { return 0.3f * std::sin(0.05f * static_cast<float>(i)); });
  r.lines.clear();
  r.Run(9600, [](int i) { return 0.3f * std::sin(0.05f * static_cast<float>(i)); });
  CHECK(Field(r.Last("[M]"), "sd") == -1200);
}
