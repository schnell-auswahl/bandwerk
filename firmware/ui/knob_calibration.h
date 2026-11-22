// Calibration of the six pots: maps what the ADC reports to 0..1 over the real
// mechanical travel. Hardware-free.
//
// Measured on the pedal (tools/knob_range.py): every pot reads 0.000
// at the left stop but only 0.969 at the right stop (all six alike, so it is a
// property of the analog front end, not of single pots). Without calibration
// the full-right value (100 %, e.g. a stored loop mix of 1.0) could never be
// picked up. Re-measure with tools/knob_range.py when the hardware changes
// (the live telemetry field "kr" carries the raw readings).
#pragma once

namespace bm {

constexpr float kKnobRawMin[6] = {0.000f, 0.000f, 0.000f, 0.000f, 0.000f, 0.000f};
constexpr float kKnobRawMax[6] = {0.969f, 0.969f, 0.969f, 0.969f, 0.969f, 0.969f};

// The last bit of travel at each end counts as the end stop, so that 0 % and
// 100 % are reached reliably despite ADC noise and supply drift.
constexpr float kKnobEndMargin = 0.004f;

inline float NormalizeKnob(float raw, float lo, float hi) {
  lo += kKnobEndMargin;
  hi -= kKnobEndMargin;
  if (hi <= lo) return raw < 0.0f ? 0.0f : (raw > 1.0f ? 1.0f : raw);  // bad constants
  const float t = (raw - lo) / (hi - lo);
  return t < 0.0f ? 0.0f : (t > 1.0f ? 1.0f : t);
}

inline float NormalizeKnob(int index, float raw) {
  return NormalizeKnob(raw, kKnobRawMin[index], kKnobRawMax[index]);
}

}  // namespace bm
