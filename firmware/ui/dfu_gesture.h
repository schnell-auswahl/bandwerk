// FS1 + FS2 held for hold_ms starts the bootloader. Hardware-free.
//
// Hothouse::CheckResetToBootloader() restarts its timer whenever either switch
// reads "released" for even a single sample (0.7 ms debounce), so a slightly
// wobbling foot keeps the gesture from ever completing. This version works on
// the debounced switch states and tolerates short dropouts (grace_ms).
#pragma once

#include <cstdint>

namespace bm {

class DfuGesture {
 public:
  struct Config {
    uint32_t hold_ms = 2000;
    uint32_t grace_ms = 120;  // dropouts shorter than this do not reset the timer
  };

  DfuGesture() = default;
  explicit DfuGesture(const Config& cfg) : cfg_(cfg) {}

  // `a` and `b`: debounced pressed state of FS1 and FS2.
  // Returns true once the gesture is complete.
  bool Update(bool a, bool b, uint32_t now) {
    if (a && b) {
      if (!active_) {
        active_ = true;
        start_ = now;
      }
      last_both_ = now;
    } else if (active_ && now - last_both_ > cfg_.grace_ms) {
      active_ = false;
    }
    return active_ && (now - start_) >= cfg_.hold_ms;
  }

  bool active() const { return active_; }
  uint32_t held_ms(uint32_t now) const { return active_ ? now - start_ : 0; }

 private:
  Config cfg_;
  bool active_ = false;
  uint32_t start_ = 0;
  uint32_t last_both_ = 0;
};

}  // namespace bm
