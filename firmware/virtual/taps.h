// Taps for the graphs of the web studio: decimated scope buffers and a band
// spectrum, produced inside the virtual pedal and only while somebody asks for
// them (the host enables them). Hardware-free, no allocation.
//
//   ScopeTap     IN, -1 octave (sub), +1 octave (up) and OUT, every 8th sample
//                (6 kHz at 48 kHz; the mean of 8 samples, so no aliasing to speak of)
//   SpectrumTap  amplitude spectrum in dBFS of IN, the low band and the high
//                band, 96 log-spaced bands from 20 Hz to 20 kHz, 23 frames/s
#pragma once

#include <cmath>
#include <cstdint>

namespace bm {
namespace virt {

constexpr int kScopeChannels = 4;  // in, sub, up, out
constexpr int kScopeDecim = 8;

class ScopeTap {
 public:
  static constexpr int kRing = 4096;  // points per channel

  void Reset() {
    count_ = 0;
    read_ = 0;
    n_ = 0;
    for (float& a : acc_) a = 0.0f;
  }

  void Push(float in, float sub, float up, float out) {
    acc_[0] += in;
    acc_[1] += sub;
    acc_[2] += up;
    acc_[3] += out;
    if (++n_ < kScopeDecim) return;
    const int pos = static_cast<int>(count_ & (kRing - 1));
    for (int c = 0; c < kScopeChannels; ++c) {
      ring_[c][pos] = acc_[c] * (1.0f / kScopeDecim);
      acc_[c] = 0.0f;
    }
    n_ = 0;
    ++count_;
  }

  // Copies the points added since the last call (the newest `max` of them)
  // into dst[c * stride + i] and returns how many.
  int Pull(float* dst, int stride, int max) {
    uint64_t from = read_;
    if (count_ - from > static_cast<uint64_t>(kRing)) from = count_ - kRing;
    if (count_ - from > static_cast<uint64_t>(max)) from = count_ - max;
    const int n = static_cast<int>(count_ - from);
    for (int i = 0; i < n; ++i) {
      const int pos = static_cast<int>((from + i) & (kRing - 1));
      for (int c = 0; c < kScopeChannels; ++c) dst[c * stride + i] = ring_[c][pos];
    }
    read_ = count_;
    return n;
  }

 private:
  float ring_[kScopeChannels][kRing] = {};
  float acc_[kScopeChannels] = {};
  uint64_t count_ = 0, read_ = 0;
  int n_ = 0;
};

constexpr int kSpecBands = 96;
constexpr int kSpecSignals = 3;  // in, low band, high band
constexpr int kSpecSize = 4096;  // FFT length
constexpr int kSpecHop = 2048;
constexpr float kSpecMinHz = 20.0f;
constexpr float kSpecMaxHz = 20000.0f;

class SpectrumTap {
 public:
  void Init(float sample_rate) {
    fs_ = sample_rate;
    for (int i = 0; i < kSpecSize / 2; ++i) {
      tw_re_[i] = cosf(6.28318530717959f * i / kSpecSize);
      tw_im_[i] = -sinf(6.28318530717959f * i / kSpecSize);
    }
    for (int i = 0; i < kSpecSize; ++i) {
      win_[i] = 0.5f - 0.5f * cosf(6.28318530717959f * i / kSpecSize);
    }
    for (int b = 0; b < kSpecBands; ++b) {
      freq_[b] = kSpecMinHz * powf(kSpecMaxHz / kSpecMinHz, (b + 0.5f) / kSpecBands);
    }
    Reset();
  }

  void Reset() {
    w_ = 0;
    since_ = 0;
    stage_ = kSpecSignals;
    have_ = false;
    filled_ = 0;
  }

  void Push(float in, float low, float high) {
    ring_[0][w_] = in;
    ring_[1][w_] = low;
    ring_[2][w_] = high;
    w_ = (w_ + 1) & (kSpecSize - 1);
    if (filled_ < kSpecSize) ++filled_;
    ++since_;
    if (since_ == kSpecHop && filled_ >= kSpecSize) {
      since_ = 0;
      for (int s = 0; s < kSpecSignals; ++s) {
        for (int i = 0; i < kSpecSize; ++i) snap_[s][i] = ring_[s][(w_ + i) & (kSpecSize - 1)];
      }
      stage_ = 0;
    } else if (since_ == kSpecHop) {
      since_ = 0;
    }
    // One FFT per stage, spread 256 samples apart so that no audio callback
    // carries all of them.
    if (stage_ < kSpecSignals && (since_ & 255) == 0 && since_ > 0) {
      Analyze(stage_);
      if (++stage_ == kSpecSignals) have_ = true;
    }
  }

  // True once when a new frame is ready; copies kSpecSignals * kSpecBands dBFS
  // values (signal-major) into dst.
  bool Pull(float* dst) {
    if (!have_) return false;
    have_ = false;
    for (int s = 0; s < kSpecSignals; ++s)
      for (int b = 0; b < kSpecBands; ++b) dst[s * kSpecBands + b] = db_[s][b];
    return true;
  }

  const float* band_hz() const { return freq_; }

 private:
  void Analyze(int s) {
    for (int i = 0; i < kSpecSize; ++i) {
      re_[i] = 0.0f;
      im_[i] = 0.0f;
    }
    // bit-reversed input with the Hann window applied
    for (int i = 0; i < kSpecSize; ++i) re_[Reverse(i)] = snap_[s][i] * win_[i];
    for (int len = 2; len <= kSpecSize; len <<= 1) {
      const int half = len >> 1;
      const int step = kSpecSize / len;
      for (int i = 0; i < kSpecSize; i += len) {
        for (int j = 0; j < half; ++j) {
          const float wr = tw_re_[j * step], wi = tw_im_[j * step];
          const int a = i + j, b = a + half;
          const float tr = re_[b] * wr - im_[b] * wi;
          const float ti = re_[b] * wi + im_[b] * wr;
          re_[b] = re_[a] - tr;
          im_[b] = im_[a] - ti;
          re_[a] += tr;
          im_[a] += ti;
        }
      }
    }
    // amplitude of a sine = 4 |X| / N for the Hann window
    const float scale = 4.0f / kSpecSize;
    const float bin_hz = fs_ / kSpecSize;
    for (int b = 0; b < kSpecBands; ++b) {
      float lo = kSpecMinHz * powf(kSpecMaxHz / kSpecMinHz, static_cast<float>(b) / kSpecBands);
      float hi = kSpecMinHz * powf(kSpecMaxHz / kSpecMinHz, static_cast<float>(b + 1) / kSpecBands);
      // Bands narrower than a bin (below ~150 Hz) are widened to one bin around
      // their centre, so a tone shows up in the bands next to it at its full level.
      const float c = freq_[b];
      if (hi - lo < bin_hz) {
        lo = c - 0.5f * bin_hz;
        hi = c + 0.5f * bin_hz;
      }
      int k0 = static_cast<int>(lo / bin_hz + 0.5f);
      int k1 = static_cast<int>(hi / bin_hz + 0.5f);  // exclusive
      if (k1 <= k0) k1 = k0 + 1;
      float amp = 0.0f;
      for (int k = k0; k < k1 && k < kSpecSize / 2; ++k) {
        const float a = sqrtf(re_[k] * re_[k] + im_[k] * im_[k]) * scale;
        if (a > amp) amp = a;
      }
      db_[s][b] = amp > 1.0e-6f ? 20.0f * log10f(amp) : -120.0f;
    }
  }

  static int Reverse(int i) {
    int r = 0;
    for (int bit = 0; bit < 12; ++bit) r |= ((i >> bit) & 1) << (11 - bit);
    return r;
  }

  float fs_ = 48000.0f;
  float tw_re_[kSpecSize / 2], tw_im_[kSpecSize / 2], win_[kSpecSize];
  float freq_[kSpecBands];
  float ring_[kSpecSignals][kSpecSize] = {};
  float snap_[kSpecSignals][kSpecSize] = {};
  float re_[kSpecSize], im_[kSpecSize];
  float db_[kSpecSignals][kSpecBands] = {};
  int w_ = 0, since_ = 0, stage_ = kSpecSignals, filled_ = 0;
  bool have_ = false;
};

}  // namespace virt
}  // namespace bm
