// The mono signal chain (IN L -> OUT L). Hardware-free, processes one sample
// at a time. Grows milestone by milestone; the places where later stages plug
// in are marked with "HOOK".
//
//   M2:  trim -> DC blocker -> crossover LR4 -> band mixer -> master -> soft clip
//        global bypass: raw IN L crossfaded in (10 ms), FX send muted
//   M3:  one compressor per band right after the crossover
//   M5:  octaver (-1 into the low sum, +1 into the high sum), detector runs always
//   M6:  drive on the high band (+ fuzz split of the low band), both bands delayed by the
//        drive's constant latency so that the crossover sum stays flat
//   M4:  FX loop on the high band after its compressor (send on OUT R, return
//        from IN R, mix, phase), the low band and the dry part of the mix are
//        delayed by the loop's round trip (+ trim) so that everything lines up
#pragma once

#include <cmath>

#include "dsp/compressor.h"
#include "dsp/crossover_lr4.h"
#include "dsp/delay.h"
#include "dsp/drive.h"
#include "dsp/loop_delay.h"
#include "dsp/dc_blocker.h"
#include "dsp/mapping.h"
#include "dsp/math_utils.h"
#include "dsp/octaver.h"
#include "dsp/smoother.h"
#include "dsp/soft_clip.h"

namespace bm {

// Normalized compressor parameters as stored by the UI (0..1).
struct CompNorm {
  float threshold, ratio, release, dry_wet;
};

// Normalized parameters as stored by the UI (0..1), plus the bypass state.
struct ChainParams {
  float master = 0.5f;     // K1
  float crossover = 0.5f;  // K3
  float band_mix = 0.5f;   // K4 on page DRIVE
  bool bypass = false;
  // [0] = high band, [1] = low band; factory defaults
  CompNorm comp[2] = {{0.647f, 0.414f, 0.463f, 0.6f},
                      {0.471f, 0.431f, 0.528f, 1.0f}};
  // Octaver (page OCTAVE), factory defaults: both levels 100 %, dry/wet both full
  bool octave_on = false;       // FS1
  float oct_level_down = 0.5f;  // K2
  float oct_dry_wet = 0.5f;     // K4
  float oct_level_up = 0.5f;    // K5
  float oct_sub_tone = 0.5f;    // K6
  // Drive (page DRIVE): type from switch S3 (0 overdrive, 1 distortion, 2 fuzz)
  bool drive_on = false;        // FS2
  int drive_type = 1;
  float drive_gain = 0.5f;      // K2
  float drive_level = 0.5f;     // K5
  float drive_tone = 0.5f;      // K6
  // FX loop (page LOOP): mode from switch S2 (0 bridge, 1 loop, 2 loop + phase invert)
  int loop_mode = 0;
  float loop_send = 0.5f;    // K2, 0 dB
  float loop_mix = 1.0f;     // K4, 100 % return (serial)
  float loop_return = 0.5f;  // K5, 0 dB
  float loop_trim = 0.5f;    // K6, fine trim +-1 ms (12 o'clock = 0)
  float loop_latency = 0.0f; // measured send -> return in samples, 0 = use kLoopRoundTripSamples
};

// Fixed values compiled into the code; measure at the pedal.
constexpr float kInputTrimDb = 0.0f;
// Send trim for typical pedal input levels (to be measured).
constexpr float kSendTrimDb = 0.0f;
// Samples from OUT R back to IN R with the send wired straight to the return
// (codec + block buffering). Measured with `looptest`: 42.81
// (three identical runs, return -1.2 dB, correlation 0.80).
constexpr float kLoopRoundTripSamples = 42.81f;

// Peak levels (linear, absolute) since the last TakeMeters() call.
struct ChainMeters {
  float in = 0.0f;    // raw input
  float out = 0.0f;   // final output
  float low = 0.0f;   // low band after the crossover
  float high = 0.0f;  // high band after the crossover (compressor input)
  float gr_high = 0.0f;  // largest gain reduction in dB (>= 0) in the window
  float gr_low = 0.0f;
  float pitch_hz = 0.0f;  // octaver detector, 0 = no note tracked
  // Points along the chain for the live signal-chain view (peaks, linear):
  float comp_high = 0.0f;  // compressor outputs
  float comp_low = 0.0f;
  float send = 0.0f;         // FX send (OUT R), after the send level
  float ret = 0.0f;          // FX return (IN R), raw, before the return level
  float loop_out = 0.0f;     // high band after the loop mix
  float low_delayed = 0.0f;  // low band after the loop latency compensation
  float oct_up = 0.0f;       // +1 octave as it is added to the high sum
  float oct_down = 0.0f;     // -1 octave as it is added to the low sum
  float sum_high = 0.0f;     // sums after the octaves
  float sum_low = 0.0f;
  float fuzz_feed = 0.0f;    // part of the low band moved into the drive
  float drive_out = 0.0f;    // high band after the drive
  float low_out = 0.0f;      // low band before the band mixer
  float pre_clip = 0.0f;     // after band mixer and master, before the soft clip
  float processed = 0.0f;    // after the soft clip (output without bypass)
  bool gate = false;         // octaver detector gate open (now)
  float loop_delay = 0.0f;   // current loop latency compensation in samples (now)
};

class BassChain {
 public:
  // How often the control-rate work (crossover coefficients) is done.
  static constexpr int kControlInterval = 32;  // samples, 1.5 kHz at 48 kHz

  void Init(float sample_rate, const ChainParams& p) {
    fs_ = sample_rate;
    octaver_.Init(fs_, OctSubToneHz(p.oct_sub_tone));
    float od, ow;
    OctDryWet(p.oct_dry_wet, &od, &ow);
    oct_on_.Init(fs_, 0.0025f, p.octave_on ? 1.0f : 0.0f);  // ~10 ms to 98 %
    oct_dry_.Init(fs_, 0.010f, od);
    oct_wet_.Init(fs_, 0.010f, ow);
    oct_down_.Init(fs_, 0.010f, OctLevel(p.oct_level_down));
    oct_up_.Init(fs_, 0.010f, OctLevel(p.oct_level_up));
    drive_.Init(fs_, ToDrive(p));
    low_delay_.Init(DriveStage::kLatency);
    split_.Init(fs_, 0.5f * CrossoverHz(p.crossover));
    fuzz_amt_.Init(fs_, 0.0025f, (p.drive_on && p.drive_type == 2) ? 1.0f : 0.0f);  // ~10 ms
    comp_[0].Init(fs_, kCompAttackMs[0], ToSettings(p.comp[0], 0), kCompHoldMs[0]);
    comp_[1].Init(fs_, kCompAttackMs[1], ToSettings(p.comp[1], 1), kCompHoldMs[1]);
    input_trim_ = DbToLin(kInputTrimDb);
    dc_.Init(fs_);
    const float fc = CrossoverHz(p.crossover);
    log_fc_.Init(fs_ / kControlInterval, 0.015f, logf(fc));
    applied_fc_ = fc;
    xover_.Init(fs_, fc);
    float lo, hi;
    BandMixGains(p.band_mix, &lo, &hi);
    gain_low_.Init(fs_, 0.010f, lo);
    gain_high_.Init(fs_, 0.010f, hi);
    gain_master_.Init(fs_, 0.010f, MasterGain(p.master));
    bypass_.Init(fs_, 0.0025f, p.bypass ? 1.0f : 0.0f);  // ~10 ms to 98 %
    LoopTargets t = ToLoop(p);
    loop_send_.Init(fs_, 0.010f, t.send);
    loop_ret_.Init(fs_, 0.010f, t.ret);
    loop_mix_.Init(fs_, 0.010f, t.mix);
    loop_dry_delay_.Init(fs_, t.delay);
    loop_low_delay_.Init(fs_, t.delay);
    tick_ = 0;
    last_ = p;
    have_last_ = true;
  }

  // Safe to call from the audio callback once per block. The mappings use
  // powf/logf/expf, so they are only recomputed when a value really changed
  // (they used to run 12000 times a second for values that rarely move).
  void SetParams(const ChainParams& p) {
    if (have_last_ && SameParams(p, last_)) return;
    last_ = p;
    have_last_ = true;
    log_fc_.SetTarget(logf(CrossoverHz(p.crossover)));
    float lo, hi;
    BandMixGains(p.band_mix, &lo, &hi);
    gain_low_.SetTarget(lo);
    gain_high_.SetTarget(hi);
    gain_master_.SetTarget(MasterGain(p.master));
    bypass_.SetTarget(p.bypass ? 1.0f : 0.0f);
    comp_[0].SetParams(ToSettings(p.comp[0], 0));
    comp_[1].SetParams(ToSettings(p.comp[1], 1));
    octaver_.SetSubToneHz(OctSubToneHz(p.oct_sub_tone));
    oct_on_.SetTarget(p.octave_on ? 1.0f : 0.0f);
    float od, ow;
    OctDryWet(p.oct_dry_wet, &od, &ow);
    oct_dry_.SetTarget(od);
    oct_wet_.SetTarget(ow);
    oct_down_.SetTarget(OctLevel(p.oct_level_down));
    oct_up_.SetTarget(OctLevel(p.oct_level_up));
    drive_.SetParams(ToDrive(p));
    fuzz_amt_.SetTarget((p.drive_on && p.drive_type == 2) ? 1.0f : 0.0f);
    const LoopTargets t = ToLoop(p);
    loop_send_.SetTarget(t.send);
    loop_ret_.SetTarget(t.ret);
    loop_mix_.SetTarget(t.mix);
    loop_dry_delay_.SetTarget(t.delay);
    loop_low_delay_.SetTarget(t.delay);
  }

  // Without the FX loop wiring (tests): return = silence, send discarded.
  float Process(float in) {
    float send;
    return Process(in, 0.0f, &send);
  }

  // `ret`: FX return (IN R), `send`: FX send (OUT R), both at the same sample index.
  float Process(float in, float ret, float* send) {
    if (++tick_ >= kControlInterval) {
      tick_ = 0;
      ControlTick();
    }

    float x = in * input_trim_;
    x = dc_.Process(x);

    float low, high;
    xover_.Process(x, &low, &high);

    PeakHold(&meters_.in, in);
    PeakHold(&meters_.low, low);
    PeakHold(&meters_.high, high);

    // The detectors always run; only the gain stage is skipped at dry/wet 0.
    const float comp_high = comp_[0].Process(high);
    const float comp_low = comp_[1].Process(low);

    // The octaver listens to the full signal (before the crossover). Its detector keeps
    // running when the octaver is off or in bypass, so nothing glitches on switching.
    float sub, up;
    octaver_.Process(x, &sub, &up);

    // Global bypass crossfade (0 = effect, 1 = bypass), ~10 ms. It also mutes
    // the FX send, so the pedals in the loop get nothing while bypassed.
    const float b = bypass_.Process();

    // FX loop. In Bridge the send is muted, the mix is 0 and both
    // delays are 0, so this is a plain pass-through of comp_high / comp_low.
    *send = comp_high * loop_send_.Process() * (1.0f - b);
    const float loop_dry = loop_dry_delay_.Process(comp_high);
    const float m = loop_mix_.Process();
    const float high_looped = loop_dry + (ret * loop_ret_.Process() - loop_dry) * m;
    const float low_looped = loop_low_delay_.Process(comp_low);
    PeakHold(&meters_.comp_high, comp_high);
    PeakHold(&meters_.comp_low, comp_low);
    PeakHold(&meters_.send, *send);
    PeakHold(&meters_.ret, ret);
    PeakHold(&meters_.loop_out, high_looped);
    PeakHold(&meters_.low_delayed, low_looped);

    // Octave off = direct 100 %, octaves 0; the on/off switch ramps in ~10 ms.
    const float on = oct_on_.Process();
    const float dry = 1.0f + on * (oct_dry_.Process() - 1.0f);
    const float wet = on * oct_wet_.Process();
    const float sub_part = sub * oct_down_.Process() * wet;
    const float up_part = up * oct_up_.Process() * wet;
    const float sum_low = low_looped * dry + sub_part;
    const float sum_high = high_looped * dry + up_part;
    PeakHold(&meters_.oct_down, sub_part);
    PeakHold(&meters_.oct_up, up_part);
    PeakHold(&meters_.sum_low, sum_low);
    PeakHold(&meters_.sum_high, sum_high);

    // Fuzz split: in fuzz mode with the drive on, the part of the low band between
    // fc/2 and fc moves into the drive. Otherwise the low band passes untouched (no filter
    // phase, so the crossover sum stays flat).
    float lo_lp, lo_hp;
    split_.Process(sum_low, &lo_lp, &lo_hp);
    const float amt = fuzz_amt_.Process();
    const float low_mixed = (1.0f - amt) * sum_low + amt * lo_lp;
    const float feed = amt * lo_hp;

    // Both bands have the drive's constant latency: the low band is delayed to match.
    const float low_out = low_delay_.Process(low_mixed);
    const float high_out = drive_.Process(sum_high + feed);

    PeakHold(&meters_.fuzz_feed, feed);
    PeakHold(&meters_.drive_out, high_out);
    PeakHold(&meters_.low_out, low_out);

    const float mixed = low_out * gain_low_.Process() + high_out * gain_high_.Process();
    const float pre_clip = mixed * gain_master_.Process();
    const float processed = SoftClip(pre_clip);
    PeakHold(&meters_.pre_clip, pre_clip);
    PeakHold(&meters_.processed, processed);

    // Everything above keeps running in bypass (no pumping on return).
    const float out = processed * (1.0f - b) + in * b;
    PeakHold(&meters_.out, out);
    return out;
  }

  // Returns the peaks since the last call and starts a new window. Called
  // from the main loop; a peak lost to a race with the audio callback only
  // affects the display.
  void TakeMeters(ChainMeters* m) {
    *m = meters_;
    m->gr_high = comp_[0].TakeMaxGainReductionDb();
    m->gr_low = comp_[1].TakeMaxGainReductionDb();
    m->pitch_hz = octaver_.pitch_hz();
    m->gate = octaver_.gate_open();
    m->loop_delay = loop_dry_delay_.delay();
    meters_ = ChainMeters();
  }

  float crossover_hz() const { return applied_fc_; }
  // 0 = low band untouched, 1 = fuzz split fully engaged (tests, telemetry)
  float fuzz_split_amount() const { return fuzz_amt_.value(); }

 private:
  // Fixed attack times: high 5 ms, low 10 ms.
  static constexpr float kCompAttackMs[2] = {5.0f, 10.0f};
  // Detector peak hold: long enough that low notes do not make the gain
  // reduction breathe within every cycle (a 41 Hz period is 24 ms), short
  // enough not to override the release setting (measured, see test_compressor).
  static constexpr float kCompHoldMs[2] = {5.0f, 25.0f};

  static bool SameParams(const ChainParams& a, const ChainParams& b) {
    if (a.master != b.master || a.crossover != b.crossover || a.band_mix != b.band_mix ||
        a.bypass != b.bypass) {
      return false;
    }
    if (a.drive_on != b.drive_on || a.drive_type != b.drive_type || a.drive_gain != b.drive_gain ||
        a.drive_level != b.drive_level || a.drive_tone != b.drive_tone) {
      return false;
    }
    if (a.loop_mode != b.loop_mode || a.loop_send != b.loop_send || a.loop_mix != b.loop_mix ||
        a.loop_return != b.loop_return || a.loop_trim != b.loop_trim ||
        a.loop_latency != b.loop_latency) {
      return false;
    }
    if (a.octave_on != b.octave_on || a.oct_level_down != b.oct_level_down ||
        a.oct_dry_wet != b.oct_dry_wet || a.oct_level_up != b.oct_level_up ||
        a.oct_sub_tone != b.oct_sub_tone) {
      return false;
    }
    for (int i = 0; i < 2; ++i) {
      if (a.comp[i].threshold != b.comp[i].threshold || a.comp[i].ratio != b.comp[i].ratio ||
          a.comp[i].release != b.comp[i].release || a.comp[i].dry_wet != b.comp[i].dry_wet) {
        return false;
      }
    }
    return true;
  }

  struct LoopTargets {
    float send, ret, mix, delay;
  };
  LoopTargets ToLoop(const ChainParams& p) const {
    LoopTargets t;
    if (p.loop_mode == 0) {  // Bridge
      t.send = 0.0f;
      t.ret = 0.0f;
      t.mix = 0.0f;
      t.delay = 0.0f;
      return t;
    }
    t.send = DbToLin(LoopLevelDb(p.loop_send) + kSendTrimDb);
    t.ret = DbToLin(LoopLevelDb(p.loop_return)) * (p.loop_mode == 2 ? -1.0f : 1.0f);
    t.mix = p.loop_mix < 0.0f ? 0.0f : (p.loop_mix > 1.0f ? 1.0f : p.loop_mix);
    const float base = p.loop_latency > 0.0f ? p.loop_latency : kLoopRoundTripSamples;
    t.delay = base + LoopFineMs(p.loop_trim) * 0.001f * fs_;
    if (t.delay < 0.0f) t.delay = 0.0f;
    return t;
  }

  static DriveParams ToDrive(const ChainParams& p) {
    DriveParams d;
    d.on = p.drive_on;
    d.type = p.drive_type;
    d.gain = p.drive_gain;
    d.level = p.drive_level;
    d.tone = p.drive_tone;
    return d;
  }

  static CompressorSettings ToSettings(const CompNorm& n, int band) {
    CompressorSettings s;
    s.threshold_db = CompThresholdDb(n.threshold);
    s.ratio = CompRatio(n.ratio, band);
    s.release_ms = CompReleaseMs(n.release, band);
    s.dry_wet = n.dry_wet;
    return s;
  }

  static void PeakHold(float* peak, float x) {
    const float a = fabsf(x);
    if (a > *peak) *peak = a;
  }

  void ControlTick() {
    const float fc = expf(log_fc_.Process());
    if (fabsf(fc - applied_fc_) > 0.02f) {
      xover_.SetFrequency(fc);
      split_.SetFrequency(0.5f * fc);
      applied_fc_ = fc;
    }
  }

  float fs_ = 48000.0f;
  float input_trim_ = 1.0f;
  int tick_ = 0;
  float applied_fc_ = 250.0f;

  ChainParams last_;
  bool have_last_ = false;
  ChainMeters meters_;
  Compressor comp_[2];  // [0] high, [1] low
  Octaver octaver_;
  DriveStage drive_;
  Delay low_delay_;
  CrossoverLR4 split_;   // fuzz split at fc/2
  Smoother fuzz_amt_;
  Smoother oct_on_, oct_dry_, oct_wet_, oct_down_, oct_up_;
  DcBlocker dc_;
  CrossoverLR4 xover_;
  Smoother log_fc_;
  Smoother gain_low_, gain_high_, gain_master_, bypass_;
  Smoother loop_send_, loop_ret_, loop_mix_;
  LoopDelay loop_dry_delay_, loop_low_delay_;
};

}  // namespace bm
