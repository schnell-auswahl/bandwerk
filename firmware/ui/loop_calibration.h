// Automatic FX-loop latency measurement: measure at
// power-up when S2 is not on Bridge, and every time S2 goes from Bridge to a
// loop mode. While a measurement runs (~0.1 s) the chain plays the high band
// dry (as in Bridge), so the main output never goes silent and the test noise
// never reaches it.
//
// A failed measurement (nothing comes back: effect off, muted, still booting,
// or a noise gate) keeps the last good value, blinks LED 1 shortly and
// retries every 2 s for about 30 s (digital effects can take that long to
// boot). Hardware-free; the main loop starts the probe and feeds back the
// result.
#pragma once

#include <cstdint>

#include "ui/pages.h"

namespace bm {

class LoopCalibrator {
 public:
  static constexpr uint32_t kBootDelayMs = 1000;  // after power-up, before the first try
  static constexpr uint32_t kRetryMs = 2000;
  static constexpr int kMaxTries = 15;
  static constexpr uint32_t kWarnMs = 1500;       // LED 1 blinks this long after a failure
  static constexpr float kMinLag = 8.0f;          // samples; less is not a real loop
  static constexpr float kMaxLag = 1000.0f;       // probe range and delay buffer

  void Init(LoopMode mode, uint32_t now_ms) {
    mode_ = mode;
    measuring_ = false;
    pending_ = false;
    tries_ = 0;
    warn_ = false;
    if (mode != LoopMode::kBridge) Schedule(now_ms + kBootDelayMs);
  }

  // Call every main-loop pass with the effective S2 mode. Returns true when a
  // measurement should start now (the caller starts the probe).
  bool Update(LoopMode mode, uint32_t now_ms) {
    if (mode != mode_) {
      if (mode_ == LoopMode::kBridge && mode != LoopMode::kBridge) {
        tries_ = 0;
        Schedule(now_ms);
      } else if (mode == LoopMode::kBridge) {
        pending_ = false;  // a running measurement still finishes
      }
      mode_ = mode;
    }
    if (pending_ && !measuring_ && static_cast<int32_t>(now_ms - due_ms_) >= 0) {
      pending_ = false;
      measuring_ = true;
      ++tries_;
      return true;
    }
    return false;
  }

  // Result of the measurement started by Update(). Returns true if `lag` is
  // good and should become the new loop latency.
  bool OnResult(bool found, float lag, uint32_t now_ms) {
    measuring_ = false;
    if (found && lag >= kMinLag && lag <= kMaxLag) {
      warn_ = false;
      last_result_ = 1;
      return true;
    }
    last_result_ = 0;
    warn_ = true;
    warn_until_ms_ = now_ms + kWarnMs;
    if (mode_ != LoopMode::kBridge && tries_ < kMaxTries) Schedule(now_ms + kRetryMs);
    return false;
  }

  // While true the chain must run as Bridge and the probe owns send/return.
  bool measuring() const { return measuring_; }
  bool pending() const { return pending_; }
  int tries() const { return tries_; }
  // -1 = nothing measured since power-up, 0 = last try failed, 1 = last try good
  int last_result() const { return last_result_; }

  // LED 1 override after a failed measurement: fast blink (~6 Hz). Returns
  // false when there is nothing to show.
  bool Led(uint32_t now_ms, float* level) {
    if (!warn_) return false;
    if (static_cast<int32_t>(now_ms - warn_until_ms_) >= 0) {
      warn_ = false;
      return false;
    }
    *level = ((now_ms / 80u) % 2u) ? 1.0f : 0.0f;
    return true;
  }

 private:
  void Schedule(uint32_t at_ms) {
    pending_ = true;
    due_ms_ = at_ms;
  }

  LoopMode mode_ = LoopMode::kBridge;
  bool measuring_ = false;
  bool pending_ = false;
  int tries_ = 0;
  uint32_t due_ms_ = 0;
  bool warn_ = false;
  uint32_t warn_until_ms_ = 0;
  int last_result_ = -1;
};

}  // namespace bm
