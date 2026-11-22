// Toggle switch handling with settling time.
// The raw position triggers the page change at once; the audio-relevant
// ("effective") position is only taken over after it has been stable for
// settle_ms. A quick there-and-back therefore only calls up the page.
#pragma once

#include <cstdint>

namespace bm {

enum class TogglePos : uint8_t { kUp = 0, kMiddle = 1, kDown = 2 };

class ToggleSettle {
 public:
  struct Config {
    uint32_t raw_stable_ms = 20;  // ignores contact bounce / passing "middle"
    uint32_t settle_ms = 300;
  };
  struct Result {
    bool raw_changed = false;        // new (debounced) position: change page
    bool effective_changed = false;  // new position now applies to the audio
  };

  ToggleSettle() = default;
  explicit ToggleSettle(const Config& cfg) : cfg_(cfg) {}

  // Takes over the current position without any event (power-up).
  void Init(TogglePos pos) {
    candidate_ = stable_raw_ = effective_ = pos;
  }

  Result Update(TogglePos input, uint32_t now_ms) {
    Result r;
    if (input != candidate_) {
      candidate_ = input;
      candidate_since_ = now_ms;
    }
    if (candidate_ != stable_raw_ &&
        now_ms - candidate_since_ >= cfg_.raw_stable_ms) {
      stable_raw_ = candidate_;
      stable_since_ = candidate_since_;
      r.raw_changed = true;
    }
    if (stable_raw_ != effective_ &&
        now_ms - stable_since_ >= cfg_.settle_ms) {
      effective_ = stable_raw_;
      r.effective_changed = true;
    }
    return r;
  }

  TogglePos raw() const { return stable_raw_; }
  TogglePos effective() const { return effective_; }
  bool settling() const { return stable_raw_ != effective_; }

 private:
  Config cfg_;
  TogglePos candidate_ = TogglePos::kMiddle;
  TogglePos stable_raw_ = TogglePos::kMiddle;
  TogglePos effective_ = TogglePos::kMiddle;
  uint32_t candidate_since_ = 0;
  uint32_t stable_since_ = 0;
};

}  // namespace bm
