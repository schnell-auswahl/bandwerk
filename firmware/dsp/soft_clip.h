// Output soft clipper. Linear (transparent) up to kThreshold
// (about -3 dBFS), then a smooth tanh knee towards, but never reaching, 1.0.
// Value and slope are continuous at the threshold.
#pragma once

#include <cmath>

namespace bm {

constexpr float kSoftClipThreshold = 0.7f;  // -3.1 dBFS

inline float SoftClip(float x) {
  const float a = fabsf(x);
  if (a <= kSoftClipThreshold) return x;
  const float room = 1.0f - kSoftClipThreshold;
  const float y = kSoftClipThreshold + room * tanhf((a - kSoftClipThreshold) / room);
  return x < 0.0f ? -y : y;
}

}  // namespace bm
