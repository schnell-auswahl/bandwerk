// The two virtual effect pedals that sit in the FX loop of the virtual pedal:
// a TS-style overdrive and a chorus. They stand in for real digital pedals, so
// each one has a constant latency (1.0 ms and 1.8 ms) whether it is on or off:
// that is what the FX loop latency measurement finds, and why switching
// between them without measuring again misaligns the bands.
//
// "Latency" here is the round trip from the send sample to the return sample,
// as LoopProbe measures it. The wire from OUT R to IN R already costs one
// sample in VirtualPedal (the return of sample n is the pedal's output for
// send sample n-1), so the delay inside a pedal is latency - 1 sample.
//
// Hardware-free, no allocation. Only +, *, / and the rational FastTanh run per
// sample (no libm), so native and WebAssembly builds agree exactly.
#pragma once

#include <cmath>
#include <cstdint>

#include "dsp/math_utils.h"

namespace bm {
namespace virt {

enum class FxType : int { kOverdrive = 0, kChorus = 1 };

constexpr float kOverdriveLatencyMs = 1.0f;
constexpr float kChorusLatencyMs = 1.8f;

inline float FxLatencyMs(FxType t) { return t == FxType::kOverdrive ? kOverdriveLatencyMs : kChorusLatencyMs; }

// What the host sets: type, on/off and three normalized (0..1) controls.
// Overdrive: drive, tone, level. Chorus: rate, depth, mix.
struct FxConfig {
  FxType type = FxType::kOverdrive;
  bool on = false;
  float p[3] = {0.5f, 0.5f, 0.5f};
};

// sin(2 pi x) for x in [0, 1): parabola with one refinement step (|error| < 0.0011).
inline float FastSin01(float x) {
  float t = x < 0.5f ? x : x - 1.0f;  // [-0.5, 0.5)
  float y = 8.0f * t * (1.0f - 2.0f * (t < 0.0f ? -t : t));
  return 0.225f * (y * (y < 0.0f ? -y : y) - y) + y;
}

// Delay line with a fractional read position (cubic Lagrange, exact at whole
// samples). Write() the input first, then Read(d) returns the signal from d
// samples ago (d = 0 is the sample just written). Valid for 1 <= d <= kSize - 4.
class FracDelay {
 public:
  static constexpr int kSize = 2048;  // power of two
  static constexpr int kMask = kSize - 1;

  void Clear() {
    for (float& v : buf_) v = 0.0f;
    w_ = 0;
  }
  void Write(float x) {
    buf_[w_] = x;
    w_ = (w_ + 1) & kMask;
  }
  float Read(float d) const {
    const int k = static_cast<int>(d);
    const float f = d - static_cast<float>(k);
    const float x0 = At(k);
    if (f == 0.0f) return x0;
    const float xm = At(k - 1);
    const float x1 = At(k + 1);
    const float x2 = At(k + 2);
    const float c_m = -f * (f - 1.0f) * (f - 2.0f) * (1.0f / 6.0f);
    const float c_0 = (f + 1.0f) * (f - 1.0f) * (f - 2.0f) * 0.5f;
    const float c_1 = -(f + 1.0f) * f * (f - 2.0f) * 0.5f;
    const float c_2 = (f + 1.0f) * f * (f - 1.0f) * (1.0f / 6.0f);
    return c_m * xm + c_0 * x0 + c_1 * x1 + c_2 * x2;
  }

 private:
  float At(int delay) const { return buf_[(w_ - 1 - delay) & kMask]; }
  float buf_[kSize] = {};
  int w_ = 0;
};

// TS-style overdrive: a mid hump around 720 Hz in front of a soft, symmetric
// clipper, then a tone low-pass and the level. The clipper gain follows the
// drive control (6 to 40 dB); the level control is 0 dB at 12 o'clock after a
// fixed make-up that keeps a bass level about as loud as it came in.
class TsOverdrive {
 public:
  void Init(float fs, float delay_samples) {
    fs_ = fs;
    delay_ = delay_samples;
    line_.Clear();
    z1_ = z2_ = 0.0;
    lp_ = 0.0f;
    SetParams(0.5f, 0.5f, 0.5f);
    gain_ = target_gain_;
    level_ = target_level_;
    DesignHump();
  }

  void SetParams(float drive, float tone, float level) {
    target_gain_ = DbToLin(6.0f + 34.0f * Clamp(drive, 0.0f, 1.0f));
    target_level_ = DbToLin(-14.0f + 24.0f * Clamp(level, 0.0f, 1.0f));
    const float fc = 1600.0f * powf(7.5f, Clamp(tone, 0.0f, 1.0f));  // 1.6 .. 12 kHz
    lp_a_ = 1.0f - expf(-kTwoPi * fc / fs_);
  }

  void Reset() {
    line_.Clear();
    z1_ = z2_ = 0.0;
    lp_ = 0.0f;
  }

  // `on` 0..1 blends from the bare delayed input (pedal off: same latency) to
  // the overdriven signal. The effect keeps running when off, so switching it
  // on has no state to build up.
  float Process(float x, float on) {
    line_.Write(x);
    const float in = line_.Read(delay_);
    gain_ += 0.002f * (target_gain_ - gain_);
    level_ += 0.002f * (target_level_ - level_);
    // mid hump: the signal plus a band-pass around 720 Hz (the TS gain stage
    // lifts the mids before the diodes clip)
    const double xd = in;
    const double bp = b0_ * xd + z1_;
    z1_ = -a1_ * bp + z2_;  // b1 = 0
    z2_ = -b0_ * xd - a2_ * bp;  // b2 = -b0
    const float eq = in + 1.5f * static_cast<float>(bp);
    const float clipped = FastTanh(eq * gain_);
    lp_ += lp_a_ * (clipped - lp_);
    return in + (lp_ * level_ - in) * on;
  }

 private:
  void DesignHump() {
    // RBJ band-pass (constant 0 dB peak gain), 720 Hz, Q = 0.8
    const double w0 = 2.0 * 3.14159265358979323846 * 720.0 / fs_;
    const double cw = cosf(static_cast<float>(w0));
    const double alpha = sinf(static_cast<float>(w0)) / (2.0 * 0.8);
    const double a0 = 1.0 + alpha;
    b0_ = alpha / a0;
    a1_ = -2.0 * cw / a0;
    a2_ = (1.0 - alpha) / a0;
  }

  float fs_ = 48000.0f;
  float delay_ = 47.0f;
  FracDelay line_;
  double b0_ = 0.0, a1_ = 0.0, a2_ = 0.0, z1_ = 0.0, z2_ = 0.0;
  float gain_ = 1.0f, target_gain_ = 1.0f, level_ = 1.0f, target_level_ = 1.0f;
  float lp_ = 0.0f, lp_a_ = 0.5f;
};

// Chorus: the dry signal plus a copy whose delay is swept by a sine LFO. The
// device latency is the dry path's delay; the wet path sits 5 ms (+- depth, up
// to 3.5 ms) behind it. The dry signal always stays the strongest component
// (the wet copy is at most 0.9 times as loud), so the loop measurement locks on
// to the latency and not on the delayed copy.
class Chorus {
 public:
  void Init(float fs, float delay_samples) {
    fs_ = fs;
    delay_ = delay_samples;
    line_.Clear();
    phase_ = 0.0f;
    SetParams(0.35f, 0.5f, 0.5f);
    mix_ = target_mix_;
    depth_ = target_depth_;
  }

  void SetParams(float rate, float depth, float mix) {
    rate_hz_ = 0.1f * powf(50.0f, Clamp(rate, 0.0f, 1.0f));  // 0.1 .. 5 Hz
    target_depth_ = 3.5f * 0.001f * fs_ * Clamp(depth, 0.0f, 1.0f);
    target_mix_ = Clamp(mix, 0.0f, 1.0f);
  }

  void Reset() {
    line_.Clear();
    phase_ = 0.0f;
  }

  float Process(float x, float on) {
    line_.Write(x);
    mix_ += 0.002f * (target_mix_ - mix_);
    depth_ += 0.002f * (target_depth_ - depth_);
    const float dry = line_.Read(delay_);
    const float d = delay_ + 0.005f * fs_ + depth_ * FastSin01(phase_);
    const float wet = line_.Read(d);
    phase_ += rate_hz_ / fs_;
    if (phase_ >= 1.0f) phase_ -= 1.0f;
    const float w = 0.9f * mix_ * on;
    return (dry + wet * w) / (1.0f + 0.5f * w);
  }

 private:
  float fs_ = 48000.0f;
  float delay_ = 85.4f;
  FracDelay line_;
  float phase_ = 0.0f, rate_hz_ = 0.5f;
  float depth_ = 0.0f, target_depth_ = 0.0f, mix_ = 0.5f, target_mix_ = 0.5f;
};

// The effect pedal in the loop: one device is selected; on/off and switching
// between the devices crossfade over ~5 ms. Both devices keep their latency
// in every state.
class LoopFxPedal {
 public:
  void Init(float fs) {
    fs_ = fs;
    od_.Init(fs, DelaySamples(FxType::kOverdrive));
    ch_.Init(fs, DelaySamples(FxType::kChorus));
    cfg_ = FxConfig();
    prev_type_ = cfg_.type;
    on_ = 0.0f;
    fade_ = 1.0f;
    step_ = 1.0f / (0.005f * fs);
    Apply();
  }

  void Configure(const FxConfig& c) {
    if (c.type != cfg_.type) {
      prev_type_ = cfg_.type;
      fade_ = 0.0f;  // crossfade from the old device
      if (c.type == FxType::kOverdrive) od_.Reset(); else ch_.Reset();  // starts empty
    }
    cfg_ = c;
    Apply();
  }

  // Round trip in samples this pedal adds (what the loop measurement finds).
  float latency_samples() const { return FxLatencyMs(cfg_.type) * fs_ / 1000.0f; }
  const FxConfig& config() const { return cfg_; }

  float Process(float x) {
    on_ += 0.004f * ((cfg_.on ? 1.0f : 0.0f) - on_);
    if (fade_ >= 1.0f) return Run(cfg_.type, x);
    const float a = Run(prev_type_, x);
    const float b = Run(cfg_.type, x);
    fade_ += step_;
    if (fade_ > 1.0f) fade_ = 1.0f;
    return a + (b - a) * fade_;
  }

 private:
  float DelaySamples(FxType t) const { return FxLatencyMs(t) * fs_ / 1000.0f - 1.0f; }

  void Apply() {
    od_.SetParams(cfg_.p[0], cfg_.p[1], cfg_.p[2]);
    ch_.SetParams(cfg_.p[0], cfg_.p[1], cfg_.p[2]);
  }

  float Run(FxType t, float x) {
    return t == FxType::kOverdrive ? od_.Process(x, on_) : ch_.Process(x, on_);
  }

  float fs_ = 48000.0f;
  TsOverdrive od_;
  Chorus ch_;
  FxConfig cfg_;
  FxType prev_type_ = FxType::kOverdrive;
  float on_ = 0.0f;
  float fade_ = 1.0f, step_ = 0.01f;
};

}  // namespace virt
}  // namespace bm
