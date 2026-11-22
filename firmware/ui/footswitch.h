// Footswitch state machine for two switches. Hardware-free.
//
//  - short  : fires on release if held < hold_ms
//  - hold   : fires once when hold_ms is reached while still held
//  - bypass : both switches pressed within pair_window_ms and both released
//             within pair_release_ms (measured from the first press); fires on
//             the release of the second switch. Single-switch functions never
//             fire during such a two-switch gesture.
// The 2 s DFU gesture (FS1 + FS2) is handled by Hothouse::CheckResetToBootloader
// and stays untouched: both held means no single function fires here either.
#pragma once

#include <cstdint>

namespace bm {

struct FootswitchEvents {
  enum Kind : uint8_t { kNone = 0, kShort, kHold };
  Kind fs[2] = {kNone, kNone};
  bool bypass = false;
  bool any() const { return fs[0] != kNone || fs[1] != kNone || bypass; }
};

class FootswitchLogic {
 public:
  struct Config {
    uint32_t debounce_ms = 15;  // extra filter on top of the library debounce
    uint32_t hold_ms = 500;
    uint32_t pair_window_ms = 100;
    uint32_t pair_release_ms = 800;
  };

  FootswitchLogic() = default;
  explicit FootswitchLogic(const Config& cfg) : cfg_(cfg) {}

  FootswitchEvents Update(bool raw0, bool raw1, uint32_t now) {
    FootswitchEvents ev;
    const bool raw[2] = {raw0, raw1};

    // 1. Debounce both switches and collect the edges with their real time.
    bool edge[2] = {false, false};
    uint32_t edge_time[2] = {0, 0};
    for (int i = 0; i < 2; ++i) {
      Sw& s = sw_[i];
      if (raw[i] != s.candidate) {
        s.candidate = raw[i];
        s.candidate_since = now;
      }
      if (s.candidate != s.down && now - s.candidate_since >= cfg_.debounce_ms) {
        edge[i] = true;
        edge_time[i] = s.candidate_since;
      }
    }

    // 2. Process edges in chronological order.
    int order[2] = {0, 1};
    if (edge[0] && edge[1] && edge_time[1] < edge_time[0]) {
      order[0] = 1;
      order[1] = 0;
    }
    for (int k = 0; k < 2; ++k) {
      const int i = order[k];
      if (!edge[i]) continue;
      if (sw_[i].candidate) {
        OnPress(i, edge_time[i]);
      } else {
        OnRelease(i, edge_time[i], &ev);
      }
    }

    // 3. Hold detection for switches that are still down.
    for (int i = 0; i < 2; ++i) {
      Sw& s = sw_[i];
      // `candidate` is the raw state: a release that is still being debounced
      // must not turn a 490 ms press into a hold.
      if (s.down && s.candidate && !s.overlap && !s.hold_fired &&
          now - s.press_time >= cfg_.hold_ms) {
        s.hold_fired = true;
        ev.fs[i] = FootswitchEvents::kHold;
      }
    }
    return ev;
  }

  bool pressed(int i) const { return sw_[i].down; }

 private:
  struct Sw {
    bool candidate = false;
    uint32_t candidate_since = 0;
    bool down = false;  // debounced state
    uint32_t press_time = 0;
    bool overlap = false;  // other switch was down while this one was down
    bool hold_fired = false;
    int presses = 0;  // presses within the current session
  };

  void OnPress(int i, uint32_t t) {
    Sw& s = sw_[i];
    Sw& o = sw_[1 - i];
    s.down = true;
    s.press_time = t;
    s.hold_fired = false;
    if (!o.down) {
      // First press of a new session (the other one was up).
      if (!session_active_) {
        session_active_ = true;
        session_start_ = t;
        sw_[0].presses = sw_[1].presses = 0;
        sw_[0].overlap = sw_[1].overlap = false;
        pair_gap_ok_ = false;
      }
      s.overlap = false;
    } else {
      s.overlap = true;
      o.overlap = true;
      pair_gap_ok_ = (t - o.press_time) <= cfg_.pair_window_ms;
    }
    ++s.presses;
  }

  void OnRelease(int i, uint32_t t, FootswitchEvents* ev) {
    Sw& s = sw_[i];
    Sw& o = sw_[1 - i];
    s.down = false;
    if (!s.overlap) {
      if (!s.hold_fired) {
        const uint32_t held = t - s.press_time;
        ev->fs[i] = held < cfg_.hold_ms ? FootswitchEvents::kShort
                                        : FootswitchEvents::kHold;
      }
    }
    if (!o.down) {
      // Both are up: the session is over.
      if (s.overlap && o.overlap && pair_gap_ok_ && sw_[0].presses == 1 &&
          sw_[1].presses == 1 && (t - session_start_) <= cfg_.pair_release_ms) {
        ev->bypass = true;
      }
      session_active_ = false;
      s.overlap = o.overlap = false;
    }
  }

  Config cfg_;
  Sw sw_[2];
  bool session_active_ = false;
  uint32_t session_start_ = 0;
  bool pair_gap_ok_ = false;
};

}  // namespace bm
