// Soft takeover (pickup) for knobs whose meaning changes with the page.
// Hardware-free: values are normalized 0..1.
#pragma once

#include <cmath>

namespace bm {

// Suppresses jitter on a raw knob value: the output only follows the input
// once it has moved by more than `deadzone`.
class KnobDeadzone {
 public:
  explicit KnobDeadzone(float deadzone = 0.005f) : deadzone_(deadzone) {}

  float Process(float raw) {
    if (!initialized_ || fabsf(raw - out_) > deadzone_) {
      out_ = raw;
      initialized_ = true;
    }
    return out_;
  }

  float value() const { return out_; }

 private:
  float deadzone_;
  float out_ = 0.0f;
  bool initialized_ = false;
};

// One pickup per knob. After Reset() the knob has no effect until it either
// comes within kTolerance of the stored value or crosses it (sign change of
// knob - target between two readings, so a fast turn cannot jump over it).
class SoftTakeover {
 public:
  static constexpr float kTolerance = 0.02f;

  void Reset() {
    caught_ = false;
    has_sign_ = false;
  }

  bool caught() const { return caught_; }

  // Returns true as soon as (and while) the knob controls the parameter.
  bool Update(float knob, float target) {
    if (caught_) return true;
    const float diff = knob - target;
    if (fabsf(diff) <= kTolerance) {
      caught_ = true;
      return true;
    }
    const int sign = diff > 0.0f ? 1 : -1;
    if (has_sign_ && sign != last_sign_) {
      caught_ = true;
      return true;
    }
    last_sign_ = sign;
    has_sign_ = true;
    return false;
  }

 private:
  bool caught_ = false;
  bool has_sign_ = false;
  int last_sign_ = 0;
};

}  // namespace bm
