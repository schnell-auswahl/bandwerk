// Analog-style octaver: -1 octave from a flip-flop, +1 octave from
// a rectifier. Hardware-free, one sample at a time. Monophonic by nature.
//
// Detector (analysis only, never heard):
//   AGC -> low-pass ~300 Hz (two sections) -> zero crossings with hysteresis.
//   The hysteresis thresholds follow the envelope of the filtered signal so
//   that noise and the wobble of a decaying note do not double-trigger.
//
// -1 octave: a flip-flop toggles at every rising zero crossing, giving a
//   square wave at half the frequency; low-pass (cutoff = Sub-Tone) and
//   scaled with the envelope of the ORIGINAL signal; DC blocker.
// +1 octave: |x| of the band-limited signal -> band-pass shaping -> level
//   compensation -> DC blocker.
//
// A gate (about -50 dBFS open, -57 dBFS close) switches both octaves off when
// there is no note, so that noise does not make the flip-flop chatter.
#pragma once

#include <cmath>

#include "dsp/biquad.h"
#include "dsp/dc_blocker.h"
#include "dsp/envelope.h"
#include "dsp/mapping.h"
#include "dsp/smoother.h"

namespace bm {

class Octaver {
 public:
  static constexpr float kDetectLpHz = 300.0f;
  static constexpr float kUpPreLpHz = 800.0f;   // band limit before the rectifier
  static constexpr float kUpHpHz = 90.0f;       // shaping band-pass after it
  static constexpr float kUpLpHz = 3000.0f;
  static constexpr float kUpGain = 2.356f;      // 3 pi / 4: the doubled fundamental of a
                                                // full-wave rectified sine is 4/(3 pi) of its peak
  static constexpr float kSubScale = 0.7853982f;  // pi / 4: fundamental of the square = original peak
  static constexpr float kGateOpen = 0.0032f;   // -50 dBFS
  static constexpr float kGateClose = 0.0014f;  // -57 dBFS
  static constexpr int kControlInterval = 32;

  void Init(float sample_rate, float sub_tone_hz = 200.0f) {
    fs_ = sample_rate;
    const double q = CrossoverQ();
    for (int i = 0; i < 2; ++i) {
      detect_lp_[i].SetCoeffs(DesignLowpass(kDetectLpHz, fs_, q));
      detect_lp_[i].Reset();
      sub_lp_[i].Reset();
    }
    up_pre_.SetCoeffs(DesignLowpass(kUpPreLpHz, fs_, q));
    up_hp_.SetCoeffs(DesignHighpass(kUpHpHz, fs_, q));
    up_lp_.SetCoeffs(DesignLowpass(kUpLpHz, fs_, q));
    up_pre_.Reset();
    up_hp_.Reset();
    up_lp_.Reset();

    env_.Init(fs_, 25.0f, 4.0f, 60.0f);         // amplitude of the original
    agc_env_.Init(fs_, 10.0f, 1.0f, 120.0f);    // AGC level detector
    filt_env_.Init(fs_, 25.0f, 3.0f, 60.0f);    // amplitude of the filtered signal
    gate_gain_.Init(fs_, 0.005f, 0.0f);
    sub_cutoff_.Init(fs_ / kControlInterval, 0.015f, logf(sub_tone_hz));
    applied_cutoff_ = sub_tone_hz;
    for (int i = 0; i < 2; ++i) sub_lp_[i].SetCoeffs(DesignLowpass(applied_cutoff_, fs_, q));
    dc_sub_.Init(fs_);
    dc_up_.Init(fs_);
    flip_ = false;
    above_ = false;
    gate_ = false;
    samples_since_ = 0;
    pitch_hz_ = 0.0f;
    tick_ = 0;
  }

  void SetSubToneHz(float hz) { sub_cutoff_.SetTarget(logf(hz)); }

  // x: full-band signal after trim and DC blocker.
  void Process(float x, float* sub, float* up) {
    if (++tick_ >= kControlInterval) {
      tick_ = 0;
      ControlTick();
    }

    const float env = env_.Process(x);
    if (!gate_ && env > kGateOpen) gate_ = true;
    else if (gate_ && env < kGateClose) gate_ = false;
    const float gate_gain = gate_gain_Process();

    // --- detector: AGC -> low-pass -> Schmitt trigger on the zero crossings
    const float level = agc_env_.Process(x);
    float gain = kAgcTarget / (level + 1.0e-6f);
    if (gain > kAgcMaxGain) gain = kAgcMaxGain;
    float y = x * gain;
    y = y > 1.5f ? 1.5f : (y < -1.5f ? -1.5f : y);
    y = static_cast<float>(detect_lp_[1].ProcessD(detect_lp_[0].ProcessD(y)));
    const float env_y = filt_env_.Process(y);
    float h = 0.2f * env_y;
    if (h < 0.01f) h = 0.01f;

    if (samples_since_ < 1000000) ++samples_since_;
    if (gate_) {
      if (!above_ && y > h) {
        above_ = true;
        flip_ = !flip_;  // the flip-flop: every rising crossing toggles it
        if (last_rise_valid_) {
          const float f = fs_ / static_cast<float>(samples_since_);
          if (f >= 25.0f && f <= 700.0f) pitch_hz_ = f;
        }
        last_rise_valid_ = true;
        samples_since_ = 0;
      } else if (above_ && y < -h) {
        above_ = false;
      }
    } else {
      above_ = false;
      last_rise_valid_ = false;
      pitch_hz_ = 0.0f;
    }

    // --- -1 octave
    const float square = flip_ ? 1.0f : -1.0f;
    float s = static_cast<float>(sub_lp_[1].ProcessD(sub_lp_[0].ProcessD(square)));
    *sub = dc_sub_.Process(s * kSubScale * env * gate_gain);

    // --- +1 octave
    float u = static_cast<float>(up_pre_.ProcessD(x));
    u = fabsf(u);
    u = static_cast<float>(up_lp_.ProcessD(up_hp_.ProcessD(u)));
    *up = dc_up_.Process(u * kUpGain * gate_gain);
  }

  // Detected fundamental in Hz, 0 while no note is tracked.
  float pitch_hz() const { return pitch_hz_; }
  // Noise gate of the detector (open = a note is played, the flip-flop may toggle).
  bool gate_open() const { return gate_; }

 private:
  static double CrossoverQ() { return 0.70710678118654752; }
  static constexpr float kAgcTarget = 0.5f;
  static constexpr float kAgcMaxGain = 100.0f;  // +40 dB

  float gate_gain_Process() {
    gate_gain_.SetTarget(gate_ ? 1.0f : 0.0f);
    return gate_gain_.Process();
  }

  void ControlTick() {
    const float hz = expf(sub_cutoff_.Process());
    if (fabsf(hz - applied_cutoff_) > 0.003f * applied_cutoff_) {
      const BiquadCoeffs c = DesignLowpass(hz, fs_, CrossoverQ());
      sub_lp_[0].SetCoeffs(c);
      sub_lp_[1].SetCoeffs(c);
      applied_cutoff_ = hz;
    }
  }

  float fs_ = 48000.0f;
  int tick_ = 0;
  bool flip_ = false, above_ = false, gate_ = false, last_rise_valid_ = false;
  uint32_t samples_since_ = 0;
  float pitch_hz_ = 0.0f;
  float applied_cutoff_ = 200.0f;

  PeakEnvelope env_, agc_env_, filt_env_;
  Biquad detect_lp_[2], sub_lp_[2];
  Biquad up_pre_, up_hp_, up_lp_;
  DcBlocker dc_sub_, dc_up_;
  Smoother gate_gain_, sub_cutoff_;
};

}  // namespace bm
