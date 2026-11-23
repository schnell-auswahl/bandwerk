// Measures the FX loop: sends a short noise burst on the send,
// records the return and finds the delay by cross-correlation. Also tells
// whether anything comes back at all, the gain and the polarity, so it doubles
// as a wiring check. Works through distorting effects as long as the
// correlation stays clear.
//
// Use: Start() from the main loop; the audio callback calls Process() per
// sample while running() and sends its result on OUT R; when done(), the main
// loop calls Analyze() (about 2 M multiply-adds, some ms). Hardware-free.
#pragma once

#include <cmath>
#include <cstdint>

namespace bm {

struct LoopProbeResult {
  bool found = false;       // a clear correlation peak was found
  float lag = 0.0f;         // samples from send to return (fractional)
  float gain_db = -120.0f;  // level of the return relative to the send (RMS, at that lag)
  bool inverted = false;    // the return comes back with the opposite polarity
  float coef = 0.0f;        // normalized correlation 0..1 (1 = clean copy)
  float return_rms_db = -120.0f;  // level at the return during the test
};

class LoopProbe {
 public:
  static constexpr int kBurst = 2048;    // ~43 ms of noise
  static constexpr int kMaxLag = 1024;   // ~21 ms
  static constexpr int kRecord = kBurst + kMaxLag;
  static constexpr float kLevel = 0.1f;  // peak of the noise (-20 dBFS)
  static constexpr float kMinCoef = 0.3f;

  void Start() {
    pos_ = 0;
    done_ = false;
    running_ = true;
  }
  bool running() const { return running_; }
  bool done() const { return done_; }

  // `ret`: the return input sample with the same index as the send sample
  // this call returns, so the lag found is the round trip in samples.
  float Process(float ret) {
    if (!running_) return 0.0f;
    const int p = pos_;
    rec_[p] = ret;
    const float out = p < kBurst ? Burst(p) : 0.0f;
    if (p + 1 >= kRecord) {
      running_ = false;
      done_ = true;
    }
    pos_ = p + 1;
    return out;
  }

  LoopProbeResult Analyze() const {
    Analysis a;
    a.Begin(*this);
    while (!a.Step(*this, kMaxLag)) {
    }
    return a.Result(*this);
  }

  // The same analysis in slices, for hosts with a hard real-time budget per
  // call (the virtual pedal runs it inside an audio callback). Analyze() above
  // is built on it, so the result is the same however it is sliced:
  //   Analysis a;  a.Begin(probe);  while (!a.Step(probe, 16)) {}  a.Result(probe);
  class Analysis {
   public:
    void Begin(const LoopProbe& p) {
      ss_ = 0.0;
      double rr = 0.0;
      for (int n = 0; n < kBurst; ++n) {
        const double s = Burst(n);
        ss_ += s * s;
      }
      for (int n = 0; n < kRecord; ++n) rr += static_cast<double>(p.rec_[n]) * p.rec_[n];
      return_rms_db_ = 10.0f * log10f(static_cast<float>(rr / kRecord) + 1.0e-20f);
      best_ = 0.0;
      best_lag_ = 0;
      lag_ = 0;
    }
    // Correlates up to `max_lags` more lags; true when all lags are done.
    bool Step(const LoopProbe& p, int max_lags) {
      for (; max_lags > 0 && lag_ < kMaxLag; --max_lags, ++lag_) {
        const double c = p.Corr(lag_);
        if (fabs(c) > fabs(best_)) {
          best_ = c;
          best_lag_ = lag_;
        }
      }
      return lag_ >= kMaxLag;
    }
    LoopProbeResult Result(const LoopProbe& p) const {
      LoopProbeResult r;
      r.return_rms_db = return_rms_db_;
      double c_prev = 0.0, c_next = 0.0;
      if (best_lag_ > 0) c_prev = p.Corr(best_lag_ - 1);
      if (best_lag_ < kMaxLag - 1) c_next = p.Corr(best_lag_ + 1);
      // Energy of the return over the burst window at the best lag.
      double rw = 0.0;
      for (int n = 0; n < kBurst; ++n) {
        const double v = p.rec_[n + best_lag_];
        rw += v * v;
      }
      r.coef = static_cast<float>(fabs(best_) / sqrt(ss_ * rw + 1.0e-30));
      r.found = r.coef >= kMinCoef;
      r.inverted = best_ < 0.0;
      r.gain_db = 10.0f * log10f(static_cast<float>(rw / ss_) + 1.0e-12f);
      // Parabolic interpolation of |c| around the peak for a fractional lag.
      const double a = fabs(c_prev), b = fabs(best_), c = fabs(c_next);
      const double den = a - 2.0 * b + c;
      const double frac =
          (best_lag_ > 0 && best_lag_ < kMaxLag - 1 && den < 0.0) ? 0.5 * (a - c) / den : 0.0;
      r.lag = static_cast<float>(best_lag_ + frac);
      return r;
    }

   private:
    double ss_ = 0.0;
    double best_ = 0.0;
    int best_lag_ = 0;
    int lag_ = 0;
    float return_rms_db_ = -120.0f;
  };

 private:
  // Deterministic white noise with soft 64-sample edges.
  static float Burst(int n) {
    uint32_t s = 0x9E3779B9u ^ static_cast<uint32_t>(n) * 2654435761u;
    s ^= s >> 15;
    s *= 2246822519u;
    s ^= s >> 13;
    s *= 3266489917u;
    s ^= s >> 16;
    float v = (static_cast<float>(s & 0xFFFFFF) / 8388608.0f - 1.0f) * kLevel;
    const int e = 64;
    if (n < e) v *= 0.5f - 0.5f * cosf(3.14159265f * n / e);
    if (n >= kBurst - e) v *= 0.5f - 0.5f * cosf(3.14159265f * (kBurst - n) / e);
    return v;
  }

  double Corr(int lag) const {
    double c = 0.0;
    for (int n = 0; n < kBurst; ++n) c += static_cast<double>(Burst(n)) * rec_[n + lag];
    return c;
  }

  float rec_[kRecord] = {};
  volatile int pos_ = 0;
  volatile bool running_ = false;
  volatile bool done_ = false;
};

}  // namespace bm
