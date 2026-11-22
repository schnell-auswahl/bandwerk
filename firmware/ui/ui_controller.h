// UI controller: ties together knobs, toggle switches and footswitches into
// pages, soft takeover and the parameter store. Hardware-free; the firmware
// feeds it raw readings once per main-loop pass (~1 kHz) and reads the result.
#pragma once

#include <cmath>
#include <cstdint>

#include "ui/footswitch.h"
#include "ui/leds.h"
#include "ui/pages.h"
#include "ui/soft_takeover.h"
#include "ui/toggle_settle.h"

namespace bm {

struct UiInputs {
  float knob[6] = {0, 0, 0, 0, 0, 0};  // K1..K6, 0..1
  TogglePos toggle[3] = {TogglePos::kMiddle, TogglePos::kMiddle,
                         TogglePos::kMiddle};  // S1..S3
  bool fs[2] = {false, false};                // FS1, FS2 pressed
  uint32_t now_ms = 0;
};

struct UiConfig {
  // The FS1 + FS2 bypass gesture is implemented and tested but can be
  // switched off in the firmware until it is wanted. When off, the gesture
  // still suppresses the single-switch functions but does nothing else.
  bool bypass_gesture_enabled = true;
  Page start_page = Page::kComp;
  // True when `stored` came from flash: the crossover then starts at the stored
  // value and its knob has to pick it up, like a page knob (the master always
  // follows its knob).
  bool restore_crossover = false;
};

class UiController {
 public:
  // A knob counts as "touched" once it has moved this far from where it was
  // when the page was entered.
  static constexpr float kTouchThreshold = 0.02f;
  // A page knob counts as "being edited" for this long after its last
  // movement (we cannot sense touch, only movement). Then LED 1 goes back to
  // its normal behaviour.
  static constexpr uint32_t kActiveHoldMs = 1000;

  // `stored` holds the parameters to start with (defaults or loaded from
  // flash). The switch positions at power-up apply immediately, without a
  // page change.
  void Init(const UiInputs& in, const Params& stored, const UiConfig& cfg) {
    cfg_ = cfg;
    params_ = stored;
    page_ = cfg.start_page;
    for (int i = 0; i < 3; ++i) toggles_[i].Init(in.toggle[i]);
    ApplyEffective();
    for (int i = 0; i < 6; ++i) filtered_[i] = filters_[i].Process(in.knob[i]);
    params_.master = filtered_[0];
    params_.crossover = filtered_[2];
    knob_seen_ = filtered_[0];
    follow_knob_ = true;
    xover_takeover_.Reset();
    xover_prev_ = filtered_[2];
    xover_pickup_shown_ = false;
    if (cfg.restore_crossover) {
      params_.crossover = stored.crossover;
    } else {
      xover_takeover_.Update(filtered_[2], filtered_[2]);  // no stored value: knob in control
    }
    ResetTakeover();
    bypass_ = false;
    revision_ = 1;
  }

  void Update(const UiInputs& in) {
    const uint32_t now = in.now_ms;

    // 1. Knobs: dead zone, then the global knobs act at once.
    for (int i = 0; i < 6; ++i) filtered_[i] = filters_[i].Process(in.knob[i]);
    // (A remote master stays until its knob is moved. The crossover is picked up
    // like a page knob when its value came from flash or from remote.)
    if (filtered_[0] != knob_seen_) { knob_seen_ = filtered_[0]; follow_knob_ = true; }
    if (follow_knob_) SetIfChanged(&params_.master, filtered_[0]);
    UpdateCrossoverKnob(now);

    // 2. Toggle switches: page change at once, audio meaning after settling.
    static constexpr Page kTogglePage[3] = {Page::kComp, Page::kLoop,
                                            Page::kDrive};
    for (int i = 0; i < 3; ++i) {
      const ToggleSettle::Result r = toggles_[i].Update(in.toggle[i], now);
      if (r.raw_changed) {
        leds_.NotifyPage(kTogglePage[i], now);
        GoToPage(kTogglePage[i]);
      }
      if (r.effective_changed) {
        ApplyEffective();
        if (i == 0) ResetTakeover();  // the knobs now edit other values
        ++revision_;
      }
    }

    // 3. Footswitches.
    const FootswitchEvents ev = footswitches_.Update(in.fs[0], in.fs[1], now);
    if (ev.fs[0] == FootswitchEvents::kShort) {
      params_.octave_on = !params_.octave_on;
      if (params_.octave_on) {  // switching on opens its page
        GoToPage(Page::kOctave);
        leds_.NotifyPage(Page::kOctave, now);
      }
      ++revision_;
    } else if (ev.fs[0] == FootswitchEvents::kHold) {
      GoToPage(Page::kOctave);
      leds_.NotifyPage(Page::kOctave, now);
    }
    if (ev.fs[1] == FootswitchEvents::kShort) {
      params_.drive_on = !params_.drive_on;
      if (params_.drive_on) {  // switching on opens its page
        GoToPage(Page::kDrive);
        leds_.NotifyPage(Page::kDrive, now);
      }
      ++revision_;
    } else if (ev.fs[1] == FootswitchEvents::kHold) {
      GoToPage(Page::kDrive);
      leds_.NotifyPage(Page::kDrive, now);
    }
    if (ev.bypass && cfg_.bypass_gesture_enabled) {
      bypass_ = !bypass_;
      ++revision_;
    }

    // 3b. Which page knobs are moving right now (for the LED 1 indication).
    for (int s = 0; s < kNumSlots; ++s) {
      const float k = filtered_[kSlotKnob[s]];
      if (k != slot_prev_[s]) {
        slot_prev_[s] = k;
        slot_move_ms_[s] = now;
        slot_moved_[s] = true;
      }
    }

    // 4. Soft takeover of K2, K4, K5, K6. While S1 is still settling, the
    // page-COMP knobs would edit the old band, so they wait.
    const bool comp_waiting = page_ == Page::kComp && toggles_[0].settling();
    if (!comp_waiting) {
      for (int s = 0; s < kNumSlots; ++s) {
        const float k = filtered_[kSlotKnob[s]];
        if (!touched_[s] && fabsf(k - touch_ref_[s]) > kTouchThreshold) {
          touched_[s] = true;
        }
        const bool was_caught = takeover_[s].caught();
        const float pickup = SlotPickupValue(params_, page_, band_, s);
        if (takeover_[s].Update(k, pickup)) {
          const SlotTargets t = GetSlotTargets(params_, page_, band_, s);
          for (int j = 0; j < t.count; ++j) SetIfChanged(t.value[j], k);
          if (!was_caught) ++revision_;
        }
      }
    }

    // 5. LEDs.
    LedInputs li;
    li.bypass = bypass_;
    int active = -1;
    for (int s = 0; s < kNumSlots; ++s) {
      if (slot_moved_[s] && now - slot_move_ms_[s] < kActiveHoldMs &&
          (active < 0 || slot_move_ms_[s] > slot_move_ms_[active])) {
        active = s;
      }
    }
    const bool slot_shown = active >= 0 && !comp_waiting;
    if (xover_pickup_shown_ &&
        (!slot_shown || xover_move_ms_ > slot_move_ms_[active])) {
      li.takeover_active = true;
      li.takeover_caught = xover_takeover_.caught();
      li.takeover_distance = fabsf(filtered_[2] - params_.crossover);
    } else if (slot_shown) {
      li.takeover_active = true;
      li.takeover_caught = takeover_[active].caught();
      li.takeover_distance =
          fabsf(filtered_[kSlotKnob[active]] -
                SlotPickupValue(params_, page_, band_, active));
    }
    li.page = page_;
    li.octave_on = params_.octave_on;
    li.drive_on = params_.drive_on;
    leds_.Compute(li, now, led_);
  }

  // --- remote control (development builds: host test tools) ---
  // Sets a stored parameter by its index (see ParamName), value normalized 0..1.
  // Master and crossover keep the remote value until their knob is moved again.
  bool RemoteSetParam(int idx, float norm) {
    float* p = ParamPtr(params_, idx);
    if (p == nullptr) return false;
    *p = norm < 0.0f ? 0.0f : (norm > 1.0f ? 1.0f : norm);
    if (idx == 0) follow_knob_ = false;
    if (idx == 1) xover_takeover_.Reset();
    // A knob that already picked up its value would write its position over the
    // remote value at once; make it pick up again.
    ResetTakeover();
    ++revision_;
    return true;
  }
  void RemoteSetOctave(bool on) { params_.octave_on = on; ++revision_; }
  void RemoteSetDrive(bool on) { params_.drive_on = on; ++revision_; }
  void RemoteSetBypass(bool on) { bypass_ = on; ++revision_; }
  // Drive type as switch S3 would set it; stays until a toggle switch settles on a new position.
  void RemoteSetDriveType(DriveType t) { drive_type_ = t; ++revision_; }
  // Band as switch S1 would set it; stays until a toggle switch settles on a new position. The
  // COMP knobs then edit other values, so they have to pick up again.
  void RemoteSetBand(BandSel b) {
    if (band_ != b) ResetTakeover();
    band_ = b;
    ++revision_;
  }
  // Loop mode as switch S2 would set it; stays until a toggle switch settles on a new position.
  void RemoteSetLoopMode(LoopMode m) { loop_mode_ = m; ++revision_; }
  // Result of the automatic loop measurement (samples send -> return). Stored with the settings.
  void SetLoopLatency(float samples) {
    if (params_.loop_latency != samples) {
      params_.loop_latency = samples;
      ++revision_;
    }
  }
  void RemoteGoToPage(Page p) { GoToPage(p); ++revision_; }
  // Back to the factory defaults (also octave/drive off).
  void RemoteDefaults() {
    params_ = Params();
    follow_knob_ = false;
    xover_takeover_.Reset();
    ResetTakeover();
    ++revision_;
  }

  // --- state ---
  Page page() const { return page_; }
  BandSel band() const { return band_; }
  LoopMode loop_mode() const { return loop_mode_; }
  DriveType drive_type() const { return drive_type_; }
  bool bypass() const { return bypass_; }
  const Params& params() const { return params_; }
  Params& mutable_params() { return params_; }
  float led(int i) const { return led_[i]; }
  // True while a knob that has been moved since the page was entered has not
  // yet picked up its stored value (drives the fast LED blinking).
  bool takeover_pending() const { return TakeoverPending(); }
  // Debounced footswitch state (used by the bootloader gesture).
  bool footswitch_down(int i) const { return footswitches_.pressed(i); }
  // Bit s set = slot s (K2, K4, K5, K6) is caught.
  int caught_mask() const {
    int m = 0;
    for (int s = 0; s < kNumSlots; ++s) m |= takeover_[s].caught() ? (1 << s) : 0;
    return m;
  }
  // Increments whenever something changes that is worth reporting.
  uint32_t revision() const { return revision_; }
  float StoredSlotValue(int slot) {
    return SlotPickupValue(params_, page_, band_, slot);
  }

 private:
  void SetIfChanged(float* dst, float v) {
    if (*dst != v) {
      *dst = v;
      ++revision_;
    }
  }

  // K3 picks up the crossover (stored or remote value) and then stays in control
  // across page changes. LED 1 shows it only while a pickup is going on.
  void UpdateCrossoverKnob(uint32_t now) {
    const float k = filtered_[2];
    const bool moved = k != xover_prev_;
    if (moved) {
      xover_prev_ = k;
      xover_move_ms_ = now;
    }
    const bool was_caught = xover_takeover_.caught();
    if (moved && !was_caught) xover_pickup_shown_ = true;
    if (xover_takeover_.Update(k, params_.crossover)) {
      SetIfChanged(&params_.crossover, k);
      if (!was_caught) ++revision_;
    }
    if (xover_pickup_shown_ && now - xover_move_ms_ >= kActiveHoldMs) xover_pickup_shown_ = false;
  }

  bool TakeoverPending() const {
    if (xover_pickup_shown_ && !xover_takeover_.caught()) return true;
    for (int s = 0; s < kNumSlots; ++s)
      if (touched_[s] && !takeover_[s].caught()) return true;
    return false;
  }

  void ResetTakeover() {
    for (int s = 0; s < kNumSlots; ++s) {
      takeover_[s].Reset();
      touch_ref_[s] = filtered_[kSlotKnob[s]];
      touched_[s] = false;
      slot_prev_[s] = filtered_[kSlotKnob[s]];
      slot_moved_[s] = false;
    }
  }

  void GoToPage(Page p) {
    if (p == page_) return;
    page_ = p;
    ResetTakeover();
    ++revision_;
  }

  void ApplyEffective() {
    switch (toggles_[0].effective()) {
      case TogglePos::kUp: band_ = BandSel::kHigh; break;
      case TogglePos::kMiddle: band_ = BandSel::kBoth; break;
      default: band_ = BandSel::kLow; break;
    }
    switch (toggles_[1].effective()) {
      case TogglePos::kUp: loop_mode_ = LoopMode::kBridge; break;
      case TogglePos::kMiddle: loop_mode_ = LoopMode::kLoop; break;
      default: loop_mode_ = LoopMode::kLoopInverted; break;
    }
    switch (toggles_[2].effective()) {
      case TogglePos::kUp: drive_type_ = DriveType::kOverdrive; break;
      case TogglePos::kMiddle: drive_type_ = DriveType::kDistortion; break;
      default: drive_type_ = DriveType::kFuzz; break;
    }
  }

  UiConfig cfg_;
  Params params_;
  Page page_ = Page::kComp;
  BandSel band_ = BandSel::kBoth;
  LoopMode loop_mode_ = LoopMode::kLoop;
  DriveType drive_type_ = DriveType::kDistortion;
  bool bypass_ = false;

  KnobDeadzone filters_[6];
  float filtered_[6] = {0, 0, 0, 0, 0, 0};
  SoftTakeover takeover_[kNumSlots];
  float touch_ref_[kNumSlots] = {0, 0, 0, 0};
  bool touched_[kNumSlots] = {false, false, false, false};
  float knob_seen_ = 0.0f;                 // last K1 value
  bool follow_knob_ = true;                // false: a remote master is active
  SoftTakeover xover_takeover_;
  float xover_prev_ = 0.0f;
  uint32_t xover_move_ms_ = 0;
  bool xover_pickup_shown_ = false;
  float slot_prev_[kNumSlots] = {0, 0, 0, 0};
  uint32_t slot_move_ms_[kNumSlots] = {0, 0, 0, 0};
  bool slot_moved_[kNumSlots] = {false, false, false, false};
  ToggleSettle toggles_[3];
  FootswitchLogic footswitches_;
  LedLogic leds_;
  float led_[2] = {0.0f, 0.0f};
  uint32_t revision_ = 0;
};

}  // namespace bm
