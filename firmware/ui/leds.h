// LED logic. Hardware-free: computes the
// brightness (0..1) of LED 1 (above FS1, octaver) and LED 2 (above FS2, drive).
//
// Base display (always, readable at a glance):
//   bypass             both off
//   effect on          its LED fully on
//   effect off         its LED breathes slowly between off and dim (both LEDs
//                      in step), i.e. "pedal is on, this effect is off"
// Temporary displays on top: a short double blink when a page is called up
// (COMP both, LOOP alternating, OCTAVE LED 1, DRIVE LED 2) and the knob
// pickup on LED 1. Priority: bypass > pickup (LED 1) > page blink > base.
#pragma once

#include <cmath>
#include <cstdint>

#include "ui/pages.h"

namespace bm {

struct LedInputs {
  bool bypass = false;
  // Knob pickup, shown on LED 1 only. `active`: a page knob is being turned
  // right now. Until the knob reaches the stored value LED 1 blinks, the
  // closer the faster; once it has, LED 1 stays on while it is edited.
  bool takeover_active = false;
  bool takeover_caught = false;
  float takeover_distance = 1.0f;  // |knob - stored value|, 0..1
  Page page = Page::kComp;         // (not shown permanently any more)
  bool octave_on = false;
  bool drive_on = false;
};

class LedLogic {
 public:
  // Pickup blink rate: kSlowHz when the knob is kFarDistance or more away from
  // the stored value, rising linearly to kFastHz at distance 0.
  static constexpr float kSlowHz = 1.0f;
  static constexpr float kFastHz = 10.0f;
  static constexpr float kFarDistance = 0.4f;
  static constexpr float kBreathMax = 0.35f;       // "dim" (user: 15 % was too dark)
  static constexpr uint32_t kBreathPeriodMs = 2500;
  static constexpr uint32_t kPageBlinkMs = 400;     // 2 blinks of 100 ms on / 100 ms off

  // Call when a page is called up (switch moved, footswitch held, effect
  // switched on): a short double blink identifies the page.
  void NotifyPage(Page p, uint32_t now_ms) {
    blink_page_ = p;
    blink_start_ = now_ms;
    blink_active_ = true;
  }

  static float Breath(uint32_t now_ms) {
    const float ph = static_cast<float>(now_ms % kBreathPeriodMs) / kBreathPeriodMs;
    return kBreathMax * (0.5f - 0.5f * cosf(6.2831853f * ph));
  }

  static float BlinkHz(float distance) {
    float t = distance / kFarDistance;
    t = t < 0.0f ? 0.0f : (t > 1.0f ? 1.0f : t);
    return kFastHz - (kFastHz - kSlowHz) * t;
  }

  void Compute(const LedInputs& in, uint32_t now_ms, float out[2]) {
    uint32_t dt = now_ms - last_ms_;
    last_ms_ = now_ms;
    if (dt > 100) dt = 100;  // first call / long gaps

    ComputeBase(in, now_ms, out);
    if (in.bypass) {
      pickup_phase_ = 0.0f;
      return;
    }

    // Knob pickup overrides LED 1 only.
    if (in.takeover_active && in.takeover_caught) {
      out[0] = 1.0f;
      pickup_phase_ = 0.0f;
    } else if (in.takeover_active) {
      pickup_phase_ += BlinkHz(in.takeover_distance) * static_cast<float>(dt) * 0.001f;
      pickup_phase_ -= floorf(pickup_phase_);
      out[0] = pickup_phase_ < 0.5f ? 1.0f : 0.0f;
    } else {
      pickup_phase_ = 0.0f;
    }
  }

 private:
  // Base display plus the page blink (everything except the pickup).
  void ComputeBase(const LedInputs& in, uint32_t now_ms, float out[2]) {
    out[0] = out[1] = 0.0f;
    if (in.bypass) return;
    const float breath = Breath(now_ms);
    out[0] = in.octave_on ? 1.0f : breath;
    out[1] = in.drive_on ? 1.0f : breath;

    if (!blink_active_) return;
    const uint32_t dt = now_ms - blink_start_;
    if (dt >= kPageBlinkMs) {
      blink_active_ = false;
      return;
    }
    const uint32_t k = dt / 100;  // 0..3: on, off, on, off
    const float on = (k % 2 == 0) ? 1.0f : 0.0f;
    switch (blink_page_) {
      case Page::kComp: out[0] = out[1] = on; break;
      case Page::kLoop:  // alternating
        out[0] = (k == 0 || k == 2) ? 1.0f : 0.0f;
        out[1] = (k == 1 || k == 3) ? 1.0f : 0.0f;
        break;
      case Page::kOctave: out[0] = on; break;
      default: out[1] = on; break;
    }
  }

  Page blink_page_ = Page::kComp;
  uint32_t blink_start_ = 0;
  bool blink_active_ = false;
  uint32_t last_ms_ = 0;
  float pickup_phase_ = 0.0f;  // 0..1, LED 1 is on in the first half
};

}  // namespace bm
