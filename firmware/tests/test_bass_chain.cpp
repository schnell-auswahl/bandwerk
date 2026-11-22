#include <cmath>
#include <vector>

#include "dsp/bass_chain.h"
#include "test_framework.h"

using namespace bm;

namespace {

constexpr float kFs = 48000.0f;
constexpr float kPi_ = 3.14159265358979f;

// Runs a sine through the chain and returns the output gain in dB, measured
// as the RMS ratio over the last half second (after everything settled).
double SineGainDb(BassChain& c, float freq, float amp, int seconds = 2) {
  double in2 = 0.0, out2 = 0.0;
  const int n = static_cast<int>(kFs) * seconds;
  for (int i = 0; i < n; ++i) {
    const float x = amp * sinf(2.0f * kPi_ * freq * static_cast<float>(i) / kFs);
    const float y = c.Process(x);
    if (i >= n - static_cast<int>(kFs) / 2) {
      in2 += static_cast<double>(x) * x;
      out2 += static_cast<double>(y) * y;
    }
  }
  return 10.0 * log10(out2 / in2);
}

// Compressors switched off (dry/wet 0): the chain is then transparent apart
// from crossover, DC blocker, master and band mix.
ChainParams NoComp() {
  ChainParams p;
  p.comp[0].dry_wet = 0.0f;
  p.comp[1].dry_wet = 0.0f;
  return p;
}

BassChain MakeChain(const ChainParams& p) {
  BassChain c;
  c.Init(kFs, p);
  return c;
}

}  // namespace

TEST(neutral_chain_is_flat_apart_from_the_dc_blocker) {
  const float freqs[] = {31.5f, 41.2f, 63, 100, 160, 250, 400, 630, 1000, 2500, 6300, 12500};
  for (float k3 : {0.0f, 0.5f, 1.0f}) {
    ChainParams p = NoComp();
    p.crossover = k3;
    for (float f : freqs) {
      BassChain c = MakeChain(p);
      const double expected =
          -10.0 * log10(1.0 + (5.0 / f) * (5.0 / f));  // 5 Hz DC blocker
      const double g = SineGainDb(c, f, 0.2f);
      if (fabs(g - expected) > 0.05) {
        std::printf("    k3=%.1f f=%.1f gain %.3f dB expected %.3f dB\n", k3, f, g, expected);
      }
      CHECK_NEAR(g, expected, 0.05);
    }
  }
}

TEST(master_sets_the_level) {
  ChainParams p = NoComp();
  p.master = 1.0f;  // +6 dB
  BassChain c = MakeChain(p);
  CHECK_NEAR(SineGainDb(c, 1000.0f, 0.1f), 6.0, 0.1);
  p.master = 0.0f;  // -inf
  c = MakeChain(p);
  CHECK(SineGainDb(c, 1000.0f, 0.1f) < -120.0);
}

TEST(band_mixer_isolates_the_bands) {
  // 100 Hz is far below, 4 kHz far above the 250 Hz crossover
  ChainParams p = NoComp();
  p.band_mix = 0.0f;  // high band muted
  BassChain c = MakeChain(p);
  CHECK(SineGainDb(c, 4000.0f, 0.1f) < -60.0);
  c = MakeChain(p);
  CHECK(SineGainDb(c, 100.0f, 0.1f) > -1.0);
  p.band_mix = 1.0f;  // low band muted
  c = MakeChain(p);
  // what is left at 100 Hz is the LR4 high-pass skirt: x^4 / (1 + x^4), x = 0.4
  CHECK_NEAR(SineGainDb(c, 100.0f, 0.1f), 20.0 * log10(pow(0.4, 4) / (1.0 + pow(0.4, 4))), 0.3);
  c = MakeChain(p);
  CHECK(SineGainDb(c, 4000.0f, 0.1f) > -0.5);
}

TEST(output_never_reaches_full_scale) {
  ChainParams p = NoComp();
  p.master = 1.0f;  // +6 dB on top of a full-scale input
  BassChain c = MakeChain(p);
  float peak = 0.0f;
  for (int i = 0; i < 48000; ++i) {
    const float x = sinf(2.0f * kPi_ * 80.0f * static_cast<float>(i) / kFs);
    peak = fmaxf(peak, fabsf(c.Process(x)));
  }
  CHECK(peak < 1.0f);
  CHECK(peak > 0.9f);  // it does clip softly, it is not silent
}

TEST(bypass_passes_input_unchanged_and_crossfades_without_clicks) {
  ChainParams p = NoComp();
  p.master = 0.25f;  // processed signal clearly differs from the input
  BassChain c = MakeChain(p);
  // run 0.5 s in normal mode, then switch bypass on while a sine is playing
  p.bypass = true;
  const int sw = 24000;
  float max_step = 0.0f, prev = 0.0f;
  float last_in = 0.0f, last_out = 0.0f;
  int ramp_end = -1;
  for (int i = 0; i < 96000; ++i) {
    if (i == sw) c.SetParams(p);
    const float x = 0.3f * sinf(2.0f * kPi_ * 110.0f * static_cast<float>(i) / kFs);
    const float y = c.Process(x);
    max_step = fmaxf(max_step, fabsf(y - prev));
    prev = y;
    if (ramp_end < 0 && i > sw && fabsf(y - x) < 1e-4f) ramp_end = i - sw;
    last_in = x;
    last_out = y;
  }
  // 0.3 * 2 pi 110 / 48000 = 0.0043 per sample for a clean sine
  CHECK(max_step < 0.01f);
  CHECK_NEAR(last_out, last_in, 1e-4);        // bypass = raw input
  CHECK(ramp_end > 0 && ramp_end < 48000 * 0.05);  // crossfade is short (< 50 ms)
  std::printf("    bypass crossfade reaches the raw input after %.1f ms\n",
              1000.0 * ramp_end / kFs);
  // and back
  p.bypass = false;
  c.SetParams(p);
  max_step = 0.0f;
  for (int i = 0; i < 48000; ++i) {
    const float y = c.Process(0.3f * sinf(2.0f * kPi_ * 110.0f * static_cast<float>(i) / kFs));
    max_step = fmaxf(max_step, fabsf(y - prev));
    prev = y;
  }
  CHECK(max_step < 0.01f);
}

TEST(crossover_sweep_is_click_free) {
  ChainParams p = NoComp();
  p.crossover = 0.0f;
  BassChain c = MakeChain(p);
  // warm up, then sweep the knob from 0 to 1 within 0.5 s
  for (int i = 0; i < 24000; ++i) c.Process(0.3f * sinf(2.0f * kPi_ * 150.0f * static_cast<float>(i) / kFs));
  float prev = 0.0f, max_step = 0.0f;
  bool finite = true;
  for (int i = 24000; i < 24000 + 48000; ++i) {
    if ((i % 48) == 0) {
      p.crossover = fminf(1.0f, static_cast<float>(i - 24000) / 24000.0f);
      c.SetParams(p);
    }
    const float y = c.Process(0.3f * sinf(2.0f * kPi_ * 150.0f * static_cast<float>(i) / kFs));
    if (!std::isfinite(y)) finite = false;
    if (i > 24001) max_step = fmaxf(max_step, fabsf(y - prev));
    prev = y;
  }
  CHECK(finite);
  // a clean 150 Hz sine at 0.3 changes by at most 0.0059 per sample
  CHECK(max_step < 0.012f);
  CHECK_NEAR(c.crossover_hz(), 800.0, 1.0);
}

TEST(crossover_frequency_follows_knob_smoothly) {
  ChainParams p = NoComp();
  BassChain c = MakeChain(p);
  CHECK_NEAR(c.crossover_hz(), 250.0, 0.01);
  p.crossover = 1.0f;
  c.SetParams(p);
  c.Process(0.0f);
  CHECK(c.crossover_hz() < 800.0f);  // not an instant jump
  for (int i = 0; i < 48000; ++i) c.Process(0.0f);
  CHECK_NEAR(c.crossover_hz(), 800.0, 1.0);
}

TEST(extreme_parameter_changes_never_produce_nan) {
  ChainParams p = NoComp();
  BassChain c = MakeChain(p);
  unsigned seed = 7;
  bool finite = true;
  for (int i = 0; i < 200000; ++i) {
    if (i % 17 == 0) {
      seed = seed * 1664525u + 1013904223u;
      p.master = (seed >> 8 & 0xffff) / 65535.0f;
      seed = seed * 1664525u + 1013904223u;
      p.crossover = (seed >> 8 & 0xffff) / 65535.0f;
      seed = seed * 1664525u + 1013904223u;
      p.band_mix = (seed >> 8 & 0xffff) / 65535.0f;
      p.bypass = (seed >> 3) & 1;
      c.SetParams(p);
    }
    seed = seed * 1664525u + 1013904223u;
    const float x = ((seed >> 8 & 0xffff) / 32768.0f - 1.0f);
    if (!std::isfinite(c.Process(x))) finite = false;
  }
  CHECK(finite);
}

TEST(meters_report_peaks_and_reset) {
  ChainParams p = NoComp();
  BassChain c = MakeChain(p);
  ChainMeters m;
  for (int i = 0; i < 9600; ++i) {
    c.Process(0.2f * sinf(2.0f * kPi_ * 1000.0f * static_cast<float>(i) / kFs));
    if (i == 4799) c.TakeMeters(&m);  // drop the start-up transient
  }
  c.TakeMeters(&m);
  CHECK_NEAR(m.in, 0.2, 0.002);
  CHECK(m.out > 0.15f && m.out < 0.25f);  // roughly unity
  CHECK(m.high > 0.15f);                  // 1 kHz is in the high band
  CHECK(m.low < 0.01f);                   // and almost absent from the low band
  c.TakeMeters(&m);                       // second call: window was reset
  CHECK(m.in == 0.0f && m.out == 0.0f);
}

// ---- compressors in the chain (M3)

namespace {
// Settled output level (dB, peak equivalent) of a sine, input level in dBFS.
double ChainOutDb(BassChain& c, float freq, double level_db) {
  return level_db + SineGainDb(c, freq, static_cast<float>(pow(10.0, level_db / 20.0)), 3);
}
}  // namespace

TEST(default_compressors_act_on_their_own_band) {
  // 2 kHz is in the high band: defaults -18 dB, 3:1, 60 % wet, makeup 7.2 dB.
  {
    ChainParams p;  // factory defaults: compressors on
    BassChain c = MakeChain(p);
    const double gain = ChainOutDb(c, 2000.0f, -10.0) + 10.0;
    const double static_gain =
        Compressor::StaticCurve(-10.0f, -18.0f, 3.0f) + 10.0 + Compressor::MakeupDb(-18.0f, 3.0f);
    const double expect = 20 * log10(0.4 + 0.6 * pow(10.0, static_gain / 20.0));
    CHECK_NEAR(gain, expect, 0.5);
    CHECK(gain > 0.3);  // the makeup outweighs the reduction at this level
  }
  // 80 Hz is in the low band: defaults -24 dB, 8:1, 100 % wet, makeup 12.6 dB.
  {
    ChainParams p;
    BassChain c = MakeChain(p);
    const double gain = ChainOutDb(c, 80.0f, -10.0) + 10.0;
    const double expect =
        Compressor::StaticCurve(-10.0f, -24.0f, 8.0f) + 10.0 + Compressor::MakeupDb(-24.0f, 8.0f);
    CHECK_NEAR(gain, expect, 0.6);
  }
}

TEST(comp_settings_are_applied_from_the_parameters) {
  ChainParams p = NoComp();
  p.comp[0].dry_wet = 1.0f;       // high band fully compressed
  p.comp[0].threshold = 0.0f;     // -40 dB
  p.comp[0].ratio = 1.0f;         // 8:1
  BassChain c = MakeChain(p);
  const double strong = ChainOutDb(c, 2000.0f, -10.0) + 10.0;
  p.comp[0].ratio = 0.0f;         // 1.5:1
  c = MakeChain(p);
  const double gentle = ChainOutDb(c, 2000.0f, -10.0) + 10.0;
  // with automatic makeup 0.6 x ... both end up near but not equal; at -10 dBFS
  // the 8:1 setting reduces more than the makeup restores
  CHECK(fabs(strong - gentle) > 1.0);
  // changing the parameters while running moves the result (smoothed)
  p.comp[0].ratio = 1.0f;
  c.SetParams(p);
  for (int i = 0; i < 48000; ++i) c.Process(0.3f * sinf(2.0f * kPi_ * 2000.0f * static_cast<float>(i) / kFs));
  ChainMeters m;
  c.TakeMeters(&m);
  CHECK(m.gr_high > 5.0f);
  CHECK(m.gr_low < 0.5f);  // the low band saw no signal
}

TEST(meters_report_gain_reduction_per_band) {
  ChainParams p;  // defaults
  BassChain c = MakeChain(p);
  ChainMeters m;
  for (int i = 0; i < 48000; ++i) c.Process(0.5f * sinf(2.0f * kPi_ * 80.0f * static_cast<float>(i) / kFs));
  c.TakeMeters(&m);
  c.TakeMeters(&m);
  for (int i = 0; i < 24000; ++i) c.Process(0.5f * sinf(2.0f * kPi_ * 80.0f * static_cast<float>(i) / kFs));
  c.TakeMeters(&m);
  CHECK(m.gr_low > 8.0f);   // -6 dBFS into -24 dB / 8:1
  CHECK(m.gr_high < 1.0f);
}

TEST(compressors_keep_running_in_bypass) {
  ChainParams p;
  p.bypass = true;
  BassChain c = MakeChain(p);
  for (int i = 0; i < 48000; ++i) c.Process(0.5f * sinf(2.0f * kPi_ * 80.0f * static_cast<float>(i) / kFs));
  ChainMeters m;
  c.TakeMeters(&m);
  CHECK(m.gr_low > 8.0f);   // detectors and envelopes are alive: nothing pumps when you come back
}

TEST(each_band_uses_its_own_compressor_settings_when_changed_while_running) {
  BassChain c = MakeChain(NoComp());
  ChainParams p = NoComp();
  p.comp[0] = {1.0f, 0.5f, 0.5f, 1.0f};  // high: threshold -6 dB, fully wet
  p.comp[1] = {0.0f, 1.0f, 0.5f, 1.0f};  // low: threshold -40 dB, 20:1, fully wet
  c.SetParams(p);
  ChainMeters m;
  for (int i = 0; i < 48000; ++i) {  // 2 kHz at -10 dBFS: high band only
    c.Process(0.316f * sinf(2.0f * kPi_ * 2000.0f * static_cast<float>(i) / kFs));
  }
  c.TakeMeters(&m);
  for (int i = 0; i < 24000; ++i) {
    c.Process(0.316f * sinf(2.0f * kPi_ * 2000.0f * static_cast<float>(i) / kFs));
  }
  c.TakeMeters(&m);
  CHECK(m.gr_high < 0.5f);  // -10 dBFS is far below the high band threshold of -6 dB
  // and the other way round with a tone in the low band
  for (int i = 0; i < 48000; ++i) {
    c.Process(0.316f * sinf(2.0f * kPi_ * 80.0f * static_cast<float>(i) / kFs));
  }
  c.TakeMeters(&m);
  for (int i = 0; i < 24000; ++i) {
    c.Process(0.316f * sinf(2.0f * kPi_ * 80.0f * static_cast<float>(i) / kFs));
  }
  c.TakeMeters(&m);
  CHECK(m.gr_low > 10.0f);  // the low band threshold of -40 dB at 20:1 clamps hard
}

TEST(repeated_identical_parameters_change_nothing_and_new_ones_still_apply) {
  ChainParams p;           // defaults, compressors on
  p.master = 0.7f;
  BassChain once = MakeChain(p), every_sample = MakeChain(p);
  once.SetParams(p);
  double worst = 0.0;
  for (int i = 0; i < 24000; ++i) {
    const float x = 0.3f * sinf(2.0f * kPi_ * 110.0f * static_cast<float>(i) / kFs);
    every_sample.SetParams(p);   // cached: must not disturb anything
    worst = fmax(worst, fabs(once.Process(x) - every_sample.Process(x)));
  }
  CHECK(worst == 0.0);
  // a changed value is picked up even though the previous call was cached
  p.master = 0.2f;
  once.SetParams(p);
  every_sample.SetParams(p);
  for (int i = 0; i < 48000; ++i) {
    const float x = 0.3f * sinf(2.0f * kPi_ * 110.0f * static_cast<float>(i) / kFs);
    once.Process(x);
    every_sample.Process(x);
  }
  ChainMeters a, b;
  once.TakeMeters(&a);           // drop the peaks of the loud phase
  every_sample.TakeMeters(&b);
  for (int i = 0; i < 4800; ++i) {
    const float x = 0.3f * sinf(2.0f * kPi_ * 110.0f * static_cast<float>(i) / kFs);
    once.Process(x);
    every_sample.Process(x);
  }
  once.TakeMeters(&a);
  every_sample.TakeMeters(&b);
  CHECK_NEAR(a.out, b.out, 1e-6);
  CHECK(a.out < 0.2f);   // and it really got quieter than at master 0.7
}

// ---- octaver in the chain (M5)

namespace {
// Level (dB) of a component of a steady sine through the chain, relative to its input amplitude.
double ChainComponentDb(BassChain& c, float f_in, float amp, double f_meas, float seconds = 2.5f) {
  const int n = static_cast<int>(kFs * seconds);
  std::vector<float> y;
  for (int i = 0; i < n; ++i)
    y.push_back(c.Process(amp * sinf(2.0f * kPi_ * f_in * static_cast<float>(i) / kFs)));
  const int a = n / 2;
  // Hann window: without it the leakage of a strong neighbour limits the reading to about -47 dB
  double re = 0, im = 0, wsum = 0;
  for (int i = a; i < n; ++i) {
    const double hann = 0.5 - 0.5 * cos(2.0 * 3.14159265358979323846 * (i - a) / (n - a));
    const double w = 2.0 * 3.14159265358979323846 * f_meas * i / kFs;
    re += hann * y[i] * cos(w);
    im += hann * y[i] * sin(w);
    wsum += hann;
  }
  const double mag = 2.0 * sqrt(re * re + im * im) / wsum;
  return 20.0 * log10(std::max(mag / amp, 1e-9));
}

ChainParams OctOn() {
  ChainParams p = NoComp();   // no compressor coloring: the octave levels read directly
  p.octave_on = true;
  return p;
}
}  // namespace

TEST(octaver_off_adds_nothing) {
  ChainParams p = NoComp();   // octave off
  BassChain c = MakeChain(p);
  CHECK(ChainComponentDb(c, 110.0f, 0.3f, 55.0) < -60.0);
  c = MakeChain(p);
  CHECK(ChainComponentDb(c, 110.0f, 0.3f, 220.0) < -60.0);
  p.oct_level_down = 1.0f;     // levels do not matter while it is off
  p.oct_dry_wet = 1.0f;
  c = MakeChain(p);
  CHECK_NEAR(ChainComponentDb(c, 110.0f, 0.3f, 110.0), 0.0, 0.3);   // direct untouched
}

TEST(octaver_on_adds_sub_and_up_at_the_right_frequencies) {
  BassChain c = MakeChain(OctOn());
  const double direct = ChainComponentDb(c, 110.0f, 0.3f, 110.0);
  c = MakeChain(OctOn());
  const double sub = ChainComponentDb(c, 110.0f, 0.3f, 55.0);
  c = MakeChain(OctOn());
  const double up = ChainComponentDb(c, 110.0f, 0.3f, 220.0);
  std::printf("    110 Hz in: direct %.1f dB, sub (55 Hz) %.1f dB, up (220 Hz) %.1f dB\n", direct, sub, up);
  CHECK_NEAR(direct, 0.0, 0.5);
  CHECK_NEAR(sub, 0.0, 2.0);    // levels 100 %: about as loud as the original
  CHECK_NEAR(up, 0.0, 2.0);
}

TEST(octave_levels_scale_0_to_200_percent) {
  ChainParams p = OctOn();
  p.oct_level_down = 0.0f;
  p.oct_level_up = 0.0f;
  BassChain c = MakeChain(p);
  CHECK(ChainComponentDb(c, 110.0f, 0.12f, 55.0) < -60.0);   // 0 %
  c = MakeChain(p);
  CHECK(ChainComponentDb(c, 110.0f, 0.12f, 220.0) < -60.0);
  p.oct_level_down = 1.0f;     // 200 %: +6 dB against 100 %
  p.oct_level_up = 1.0f;
  c = MakeChain(p);
  const double sub200 = ChainComponentDb(c, 110.0f, 0.12f, 55.0);
  c = MakeChain(OctOn());
  const double sub100 = ChainComponentDb(c, 110.0f, 0.12f, 55.0);
  CHECK_NEAR(sub200 - sub100, 6.0, 0.7);
  c = MakeChain(p);
  const double up200 = ChainComponentDb(c, 110.0f, 0.12f, 220.0);
  c = MakeChain(OctOn());
  const double up100 = ChainComponentDb(c, 110.0f, 0.12f, 220.0);
  CHECK_NEAR(up200 - up100, 6.0, 0.7);
}

TEST(octave_dry_wet_has_a_dual_taper) {
  ChainParams p = OctOn();
  p.oct_dry_wet = 0.0f;        // left stop: direct only
  BassChain c = MakeChain(p);
  CHECK_NEAR(ChainComponentDb(c, 110.0f, 0.3f, 110.0), 0.0, 0.5);
  c = MakeChain(p);
  CHECK(ChainComponentDb(c, 110.0f, 0.3f, 55.0) < -60.0);
  p.oct_dry_wet = 1.0f;        // right stop: octaves only
  c = MakeChain(p);
  CHECK(ChainComponentDb(c, 110.0f, 0.3f, 110.0) < -50.0);   // the direct tone is gone
  c = MakeChain(p);
  CHECK(ChainComponentDb(c, 110.0f, 0.3f, 55.0) > -3.0);     // the sub is still there
  p.oct_dry_wet = 0.5f;        // 12 o'clock: both full
  c = MakeChain(p);
  const double both = ChainComponentDb(c, 110.0f, 0.3f, 110.0);
  CHECK_NEAR(both, 0.0, 0.5);
}

TEST(switching_the_octaver_on_and_off_does_not_click) {
  ChainParams p = NoComp();
  BassChain c = MakeChain(p);
  float prev = 0.0f, max_step = 0.0f;
  for (int i = 0; i < 4 * 48000; ++i) {
    if (i == 48000) { p.octave_on = true; c.SetParams(p); }
    if (i == 3 * 48000) { p.octave_on = false; c.SetParams(p); }
    const float y = c.Process(0.3f * sinf(2.0f * kPi_ * 82.4f * static_cast<float>(i) / kFs));
    if (i > 2000) max_step = fmaxf(max_step, fabsf(y - prev));
    prev = y;
  }
  // a clean 82 Hz sine at 0.3 plus an equally loud octave changes at most ~0.012 per sample
  CHECK(max_step < 0.03f);
}

TEST(a_changed_octave_parameter_is_not_swallowed_by_the_cache) {
  ChainParams p = OctOn();
  BassChain c = MakeChain(p);
  p.oct_level_down = 0.0f;
  c.SetParams(p);
  CHECK(ChainComponentDb(c, 110.0f, 0.3f, 55.0) < -50.0);
}

TEST(the_detector_reports_the_pitch_also_in_bypass) {
  ChainParams p = NoComp();
  p.bypass = true;
  BassChain c = MakeChain(p);
  for (int i = 0; i < 48000; ++i) c.Process(0.3f * sinf(2.0f * kPi_ * 82.4f * static_cast<float>(i) / kFs));
  ChainMeters m;
  c.TakeMeters(&m);
  CHECK_NEAR(m.pitch_hz, 82.4, 1.5);
}

// ---- drive in the chain (M6)

namespace {
ChainParams DriveOn(int type) {
  ChainParams p = NoComp();
  p.drive_on = true;
  p.drive_type = type;
  return p;
}
// Level of the 3rd harmonic relative to the fundamental for a sine through the chain.
double ThirdHarmonicDb(const ChainParams& p, float f, float amp) {
  BassChain c = MakeChain(p);
  const double fund = ChainComponentDb(c, f, amp, f);
  c = MakeChain(p);
  const double h3 = ChainComponentDb(c, f, amp, 3.0 * f);
  return h3 - fund;
}
}  // namespace

TEST(the_drive_latency_is_matched_so_the_sum_stays_flat_with_drive_off_at_800_hz) {
  ChainParams p = NoComp();
  p.crossover = 1.0f;   // 800 Hz: a time offset between the bands would show the most here
  BassChain c = MakeChain(p);
  const double at_fc = ChainComponentDb(c, 800.0f, 0.2f, 800.0);
  c = MakeChain(p);
  const double below = ChainComponentDb(c, 560.0f, 0.2f, 560.0);
  c = MakeChain(p);
  const double above = ChainComponentDb(c, 1100.0f, 0.2f, 1100.0);
  std::printf("    fc 800 Hz, drive off: %.2f dB at 800, %.2f dB at 560, %.2f dB at 1100\n", at_fc, below, above);
  CHECK_NEAR(at_fc, 0.0, 0.2);
  CHECK_NEAR(below, 0.0, 0.2);
  CHECK_NEAR(above, 0.0, 0.2);
}

TEST(drive_on_distorts_the_high_band_and_off_leaves_the_signal_alone) {
  ChainParams off = NoComp();
  CHECK(ThirdHarmonicDb(off, 1000.0f, 0.1f) < -80.0);
  for (int type = 0; type < 3; ++type) {
    ChainParams on = DriveOn(type);
    on.drive_gain = 0.8f;
    const double h3 = ThirdHarmonicDb(on, 1000.0f, 0.1f);
    std::printf("    drive type %d at 1 kHz: 3rd harmonic %.1f dB\n", type, h3);
    CHECK(h3 > -35.0);
  }
}

TEST(low_notes_stay_much_cleaner_than_high_content_in_every_drive_mode) {
  // The drive works on the high band only. A 60 Hz note leaks into it by about -50 dB (LR4 at
  // 250 Hz), which the drive amplifies, so it is not perfectly clean, but far cleaner than 1 kHz.
  for (int type = 0; type < 3; ++type) {
    ChainParams on = DriveOn(type);          // default gain
    const double low = ThirdHarmonicDb(on, 60.0f, 0.1f);
    const double high = ThirdHarmonicDb(on, 1000.0f, 0.1f);
    std::printf("    type %d: 3rd harmonic %.1f dB for 60 Hz, %.1f dB for 1 kHz\n", type, low, high);
    CHECK(low < high - 10.0);
  }
}

TEST(fuzz_mode_sends_the_part_between_half_the_crossover_and_the_crossover_into_the_drive) {
  // fc = 250 Hz: a 190 Hz tone sits between fc/2 (125) and fc. In fuzz mode it is split off into
  // the drive and distorted; with overdrive it mostly stays in the clean low band.
  ChainParams fuzz = DriveOn(2);
  ChainParams od = DriveOn(0);
  const double fuzz_190 = ThirdHarmonicDb(fuzz, 190.0f, 0.1f);
  const double fuzz_60 = ThirdHarmonicDb(fuzz, 60.0f, 0.1f);
  const double od_190 = ThirdHarmonicDb(od, 190.0f, 0.1f);
  std::printf("    3rd harmonic: fuzz 190 Hz %.1f dB, fuzz 60 Hz %.1f dB, overdrive 190 Hz %.1f dB\n", fuzz_190, fuzz_60, od_190);
  CHECK(fuzz_190 > fuzz_60 + 5.0);    // the split pulls the 190 Hz tone into the drive
  CHECK(fuzz_190 > od_190 + 15.0);    // while the overdrive leaves it in the clean low band
}

TEST(the_fuzz_split_engages_only_for_fuzz_with_the_drive_on) {
  const struct { bool on; int type; float expect; } cases[] = {
      {false, 2, 0.0f}, {true, 0, 0.0f}, {true, 1, 0.0f}, {true, 2, 1.0f}};
  for (const auto& cs : cases) {
    ChainParams p = NoComp();
    p.drive_on = cs.on;
    p.drive_type = cs.type;
    BassChain c = MakeChain(NoComp());
    c.SetParams(p);
    for (int i = 0; i < 24000; ++i) c.Process(0.0f);
    CHECK_NEAR(c.fuzz_split_amount(), cs.expect, 0.01);
  }
}

TEST(drive_parameter_changes_are_not_swallowed_by_the_cache) {
  ChainParams p = DriveOn(1);
  p.drive_gain = 0.0f;
  BassChain c = MakeChain(p);
  c.SetParams(p);
  const double low_gain = ThirdHarmonicDb(p, 1000.0f, 0.1f);
  p.drive_gain = 1.0f;
  const double high_gain = ThirdHarmonicDb(p, 1000.0f, 0.1f);
  CHECK(high_gain > low_gain + 8.0);
  // and on a running chain
  BassChain run = MakeChain(DriveOn(1));
  ChainParams q = DriveOn(1);
  q.drive_gain = 0.0f;
  run.SetParams(q);
  for (int i = 0; i < 24000; ++i) run.Process(0.1f * sinf(2.0f * kPi_ * 1000.0f * static_cast<float>(i) / kFs));
  q.drive_on = false;
  run.SetParams(q);
  double worst = 0;
  float prev = 0;
  for (int i = 0; i < 48000; ++i) {
    const float y = run.Process(0.1f * sinf(2.0f * kPi_ * 1000.0f * static_cast<float>(i) / kFs));
    if (i > 2000) worst = fmax(worst, fabs(y - prev));
    prev = y;
  }
  CHECK(worst < 0.05);
}

TEST(drive_type_switch_in_the_chain_ends_in_the_new_type) {
  ChainParams p = DriveOn(0);
  p.drive_gain = 0.9f;
  const double od = ThirdHarmonicDb(p, 1000.0f, 0.1f);
  p.drive_type = 1;
  const double dist = ThirdHarmonicDb(p, 1000.0f, 0.1f);
  CHECK(dist > od + 5.0);   // the distortion is clearly harder than the overdrive at the same gain
}

// ---- meters along the chain (live signal-chain view)

namespace {
// Runs `seconds` of a sine on IN L (and optionally on the return), drops the
// first half, returns the meters of the second half.
ChainMeters RunChainView(BassChain& c, float freq, float amp, float ret_amp = 0.0f,
                         float seconds = 0.4f) {
  ChainMeters m;
  const int n = static_cast<int>(kFs * seconds);
  for (int i = 0; i < n; ++i) {
    const float ph = 2.0f * kPi_ * freq * static_cast<float>(i) / kFs;
    float send;
    c.Process(amp * sinf(ph), ret_amp * sinf(ph), &send);
    if (i == n / 2) c.TakeMeters(&m);
  }
  c.TakeMeters(&m);
  return m;
}
}  // namespace

TEST(chain_view_bridge_sends_nothing_and_passes_the_compressor_output) {
  ChainParams p = NoComp();
  p.loop_mode = 0;
  BassChain c = MakeChain(p);
  const ChainMeters m = RunChainView(c, 1000.0f, 0.2f, 0.3f);
  CHECK(m.send == 0.0f);
  CHECK_NEAR(m.ret, 0.3, 0.003);              // the raw return is metered anyway
  CHECK_NEAR(m.loop_out, m.comp_high, 1e-4);  // return ignored
  CHECK_NEAR(m.loop_delay, 0.0, 1e-6);
  CHECK(m.comp_high > 0.15f);
  CHECK(m.oct_up == 0.0f && m.oct_down == 0.0f);  // octaver off
  CHECK(m.fuzz_feed == 0.0f);                     // drive off
  CHECK_NEAR(m.sum_high, m.loop_out, 1e-4);
  CHECK_NEAR(m.drive_out, m.sum_high, 0.002);     // drive off = delayed dry
  CHECK_NEAR(m.pre_clip, m.processed, 1e-4);      // far below the soft-clip knee
  CHECK_NEAR(m.processed, m.out, 1e-4);           // no bypass
}

TEST(chain_view_loop_mode_meters_send_and_delay) {
  ChainParams p = NoComp();
  p.loop_mode = 1;
  p.loop_send = 1.0f;  // +12 dB
  p.loop_mix = 1.0f;
  BassChain c = MakeChain(p);
  const ChainMeters m = RunChainView(c, 1000.0f, 0.05f, 0.1f);
  CHECK_NEAR(20.0 * log10(m.send / m.comp_high), 12.0, 0.1);
  CHECK_NEAR(m.loop_delay, kLoopRoundTripSamples, 0.01);  // trim at 12 o'clock = 0
  CHECK_NEAR(m.loop_out, 0.1, 0.003);  // 100 % return at 0 dB
  CHECK(m.low_delayed >= 0.0f);
}

TEST(chain_view_octaves_are_metered_only_when_on) {
  ChainParams p = NoComp();
  p.octave_on = true;
  BassChain c = MakeChain(p);
  const ChainMeters m = RunChainView(c, 82.4f, 0.3f, 0.0f, 1.0f);
  CHECK(m.oct_down > 0.05f);
  CHECK(m.oct_up > 0.01f);
  CHECK(m.gate);
  CHECK(m.sum_low > m.low_delayed * 0.5f);
  ChainParams q = p;
  q.oct_dry_wet = 0.0f;  // left stop: direct only, octaves 0
  BassChain d = MakeChain(q);
  const ChainMeters n = RunChainView(d, 82.4f, 0.3f, 0.0f, 1.0f);
  CHECK(n.oct_down < 1e-4f && n.oct_up < 1e-4f);
}

TEST(chain_view_fuzz_feed_only_with_drive_on_and_fuzz) {
  ChainParams p = NoComp();
  p.drive_on = true;
  p.drive_type = 1;  // distortion: no split
  BassChain c = MakeChain(p);
  CHECK(RunChainView(c, 170.0f, 0.2f).fuzz_feed == 0.0f);
  p.drive_type = 2;  // fuzz: fc/2 .. fc (125..250 Hz) goes into the drive
  BassChain d = MakeChain(p);
  const ChainMeters m = RunChainView(d, 170.0f, 0.2f);
  CHECK(m.fuzz_feed > 0.05f);
}

TEST(chain_view_soft_clip_reduction_is_visible_when_driven_hard) {
  ChainParams p = NoComp();
  p.master = 1.0f;  // +6 dB
  BassChain c = MakeChain(p);
  const ChainMeters m = RunChainView(c, 1000.0f, 0.9f);
  CHECK(m.pre_clip > 1.5f);
  CHECK(m.processed < 1.0f);
  CHECK(m.processed < m.pre_clip);
}

TEST(chain_view_meters_reset_after_take) {
  ChainParams p = NoComp();
  p.loop_mode = 1;
  p.octave_on = true;
  BassChain c = MakeChain(p);
  RunChainView(c, 100.0f, 0.3f, 0.2f);
  ChainMeters m;
  c.TakeMeters(&m);
  CHECK(m.comp_high == 0.0f && m.comp_low == 0.0f && m.send == 0.0f && m.ret == 0.0f);
  CHECK(m.loop_out == 0.0f && m.low_delayed == 0.0f && m.oct_up == 0.0f && m.oct_down == 0.0f);
  CHECK(m.sum_high == 0.0f && m.sum_low == 0.0f && m.drive_out == 0.0f && m.low_out == 0.0f);
  CHECK(m.pre_clip == 0.0f && m.processed == 0.0f);
  CHECK_NEAR(m.loop_delay, kLoopRoundTripSamples, 0.01);  // state, not a peak: stays
}
