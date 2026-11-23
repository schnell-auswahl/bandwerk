// The virtual pedal: the firmware's main loop and audio callback without the
// hardware, for the browser (WebAssembly in an AudioWorklet) and for the host
// tests. It uses the very same hardware-free code as bass_multiband.cpp:
// BassChain, UiController (pages, soft takeover, footswitch gestures, LEDs),
// LoopCalibrator + LoopProbe, ApplyDevCommand, and the telemetry text.
//
// What replaces the hardware:
//   knobs, toggles, footswitches   SetKnob / SetToggle / SetFootswitch
//   audio in/out                   Process(): mono in, mono out (IN L -> OUT L)
//   OUT R -> effect -> IN R        a LoopFxPedal (overdrive or chorus) with a
//                                  fixed latency, wired sample by sample
//   USB serial                     Command() and TakeTelemetry()
//   System::GetNow()               the sample count (1 ms = sample_rate / 1000)
//   flash settings                 none: the pedal starts on its defaults
//
// Time and control rate follow the firmware: audio is processed in blocks of
// 4 samples, the chain parameters are handed over once per block, and the main
// loop (UI update, loop calibration, telemetry) runs once per millisecond of
// audio time. Splitting Process() into calls of any size gives the same result.
//
// Not copied from the firmware: saving (the settings live in RAM only), the
// bootloader gesture, the dev build's extra lines ([UI], [RAW], ...). The loop
// measurement's cross-correlation is done in slices (about 64 ms instead of a
// few ms) so that it never stalls an audio callback.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

#include "dsp/bass_chain.h"
#include "dsp/loop_probe.h"
#include "ui/dev_commands.h"
#include "ui/knob_calibration.h"
#include "ui/loop_calibration.h"
#include "ui/telemetry.h"
#include "ui/ui_controller.h"
#include "version.h"
#include "virtual/fx_pedals.h"
#include "virtual/taps.h"

namespace bm {
namespace virt {

constexpr int kBlockSize = 4;  // as the firmware (hw.SetAudioBlockSize)

enum TapMask : int { kTapScope = 1, kTapSpectrum = 2 };

class VirtualPedal {
 public:
  static constexpr size_t kTelemetryCap = 8192;  // pending text; newer messages are dropped when full
  static constexpr size_t kLineMax = 96;         // longest command line, as DevLink::kLineSize

  VirtualPedal() = default;
  VirtualPedal(const VirtualPedal&) = delete;
  VirtualPedal& operator=(const VirtualPedal&) = delete;

  // (Re)starts the pedal as after a power cycle: factory defaults, S1 middle,
  // S2 up (Bridge), S3 middle, knobs at 12 o'clock, the pedal on page DRIVE.
  void Init(int sample_rate) {
    sr_ = sample_rate > 0 ? sample_rate : 48000;
    fs_ = static_cast<float>(sr_);
    samples_ = 0;
    phase_ = 0;
    last_ms_ = -1;
    for (int i = 0; i < 6; ++i) raw_knob_[i] = 0.5f * kKnobRawMax[i];
    in_ = UiInputs();
    in_.toggle[0] = TogglePos::kMiddle;
    in_.toggle[1] = TogglePos::kUp;
    in_.toggle[2] = TogglePos::kMiddle;
    ReadInputs(0);

    chain_.Init(fs_, ChainParams());
    UiConfig cfg;
    cfg.bypass_gesture_enabled = true;
    cfg.restore_crossover = false;
    cfg.start_page = Page::kDrive;
    Params start;
    ui_.Init(in_, start, cfg);
    loop_cal_.Init(ui_.loop_mode(), 0);
    probe_waiting_ = false;
    probe_due_ms_ = 0;
    analysing_ = false;
    probe_ = LoopProbe();
    fx_.Init(fs_);
    ret_ = 0.0f;
    cp_ = ChainParams();
    BuildChainParams();

    tel_len_ = 0;
    last_report_ = 0;
    last_ui_print_ = 0;
    printed_revision_ = 0;
    loop_count_ = 0;
    last_live_ = 0;
    cpu_avg_ = cpu_max_ = 0.0f;

    taps_mask_ = 0;
    scope_.Reset();
    spectrum_.Init(fs_);
  }

  // Mono in -> mono out, any number of samples (the audio callback of the
  // worklet passes 128). `in` and `out` may be the same buffer.
  void Process(const float* in, float* out, int n) {
    for (int i = 0; i < n; ++i) {
      if (phase_ == 0) BlockStart();
      out[i] = Tick(in[i]);
      if (++phase_ == kBlockSize) phase_ = 0;
      ++samples_;
    }
  }

  // One remote command line (docs/PROTOCOL.md), without line ending. Writes the
  // reply ("ok ..." or "err ...", without the "[CMD] " tag) and returns true
  // when the command was understood. Takes effect immediately, which is as if
  // the firmware's main loop had picked it up first thing in its next pass.
  bool Command(const char* line, char* reply, size_t cap) {
    char buf[kLineMax];
    std::strncpy(buf, line != nullptr ? line : "", kLineMax - 1);
    buf[kLineMax - 1] = '\0';
    // Commands that need the real hardware.
    char word[16];
    size_t n = 0;
    const char* p = buf;
    while (*p == ' ' || *p == '\t') ++p;
    while (*p != '\0' && *p != ' ' && *p != '\t' && n < sizeof word - 1) word[n++] = *p++;
    word[n] = '\0';
    static const char* const kHardware[] = {"dfu", "reboot", "save", "wipe", "looptest"};
    for (const char* h : kHardware) {
      if (devkit::Is(word, h)) {
        devkit::Reply(reply, cap, "err", "not available in the virtual pedal");
        return false;
      }
    }
    BuildInfo info;
    info.fw = BM_FW_VERSION;
    info.proto = BM_PROTO_VERSION;
    info.build = "virtual";
    info.app = "wasm";
    RemoteAction action = RemoteAction::kNone;
    return ApplyDevCommand(ui_, buf, reply, cap, info, &action);
  }

  // --- the "hardware" ---
  // Knob position 0..1 (the left to the right stop). Out of range is clamped.
  void SetKnob(int i, float v01) {
    if (i < 0 || i >= 6) return;
    const float v = v01 < 0.0f ? 0.0f : (v01 > 1.0f ? 1.0f : v01);
    raw_knob_[i] = kKnobRawMin[i] + v * (kKnobRawMax[i] - kKnobRawMin[i]);
  }
  // Toggle switch S1..S3 (index 0..2): 0 = up, 1 = middle, 2 = down.
  void SetToggle(int i, int pos) {
    if (i < 0 || i >= 3 || pos < 0 || pos > 2) return;
    in_.toggle[i] = static_cast<TogglePos>(pos);
  }
  void SetFootswitch(int i, bool down) {
    if (i < 0 || i >= 2) return;
    in_.fs[i] = down;
  }

  // The effect pedal in the FX loop (type, on/off, three controls 0..1).
  void SetLoopFx(const FxConfig& c) { fx_.Configure(c); }
  const FxConfig& loop_fx() const { return fx_.config(); }
  float loop_fx_latency_samples() const { return fx_.latency_samples(); }

  // CPU load to report in [SYS] (0..1). The host measures it, the pedal cannot.
  void SetCpuLoad(float avg, float max) {
    cpu_avg_ = avg;
    cpu_max_ = max;
  }

  // Moves the pending telemetry text (whole lines, each ending in \r\n) into
  // dst (NUL terminated) and returns its length. Text that does not fit stays.
  size_t TakeTelemetry(char* dst, size_t cap) {
    if (cap == 0) return 0;
    size_t n = tel_len_ < cap - 1 ? tel_len_ : cap - 1;
    // do not cut a line in half
    while (n > 0 && n < tel_len_ && tel_[n - 1] != '\n') --n;
    std::memcpy(dst, tel_, n);
    dst[n] = '\0';
    std::memmove(tel_, tel_ + n, tel_len_ - n);
    tel_len_ -= n;
    return n;
  }

  // --- taps (only produced while enabled) ---
  void EnableTaps(int mask) {
    if ((mask & kTapScope) && !(taps_mask_ & kTapScope)) scope_.Reset();
    if ((mask & kTapSpectrum) && !(taps_mask_ & kTapSpectrum)) spectrum_.Reset();
    taps_mask_ = mask;
  }
  int PullScope(float* dst, int stride, int max) { return scope_.Pull(dst, stride, max); }
  bool PullSpectrum(float* dst) { return spectrum_.Pull(dst); }
  const float* spectrum_band_hz() const { return spectrum_.band_hz(); }

  // --- state for tests and the host ---
  int sample_rate() const { return sr_; }
  uint64_t samples() const { return samples_; }
  const UiController& ui() const { return ui_; }
  UiController& mutable_ui() { return ui_; }
  const LoopCalibrator& loop_calibrator() const { return loop_cal_; }
  bool loop_measuring() const { return loop_cal_.measuring(); }
  const ChainParams& chain_params() const { return cp_; }

 private:
  // Start of a 4-sample block: the main loop pass of the firmware when a
  // millisecond has passed, then the parameter handover of the audio callback.
  void BlockStart() {
    const int64_t ms = static_cast<int64_t>(samples_ * 1000ull / static_cast<uint64_t>(sr_));
    if (ms != last_ms_) {
      last_ms_ = ms;
      MainLoopPass(static_cast<uint32_t>(ms));
    }
    chain_.SetParams(cp_);
  }

  void ReadInputs(uint32_t now_ms) {
    for (int i = 0; i < 6; ++i) in_.knob[i] = NormalizeKnob(i, raw_knob_[i]);
    in_.now_ms = now_ms;
  }

  // Same field by field as the hand-over in the firmware's main loop
  // (g_shared) and the start of its audio callback.
  void BuildChainParams() {
    const Params& p = ui_.params();
    cp_.master = p.master;
    cp_.crossover = p.crossover;
    cp_.band_mix = p.drive_band_mix;
    cp_.bypass = ui_.bypass();
    for (int b = 0; b < 2; ++b) {
      cp_.comp[b] = {p.comp[b].threshold, p.comp[b].ratio, p.comp[b].release, p.comp[b].dry_wet};
    }
    cp_.octave_on = p.octave_on;
    cp_.oct_level_down = p.oct_level_down;
    cp_.oct_dry_wet = p.oct_dry_wet;
    cp_.oct_level_up = p.oct_level_up;
    cp_.oct_sub_tone = p.oct_sub_tone;
    cp_.drive_on = p.drive_on;
    cp_.drive_type = static_cast<int>(ui_.drive_type());
    cp_.drive_gain = p.drive_gain;
    cp_.drive_level = p.drive_level;
    cp_.drive_tone = p.drive_tone;
    // While measuring, the chain runs as Bridge (high band dry, nothing lost on OUT L).
    cp_.loop_mode = loop_cal_.measuring() ? 0 : static_cast<int>(ui_.loop_mode());
    cp_.loop_send = p.loop_send;
    cp_.loop_mix = p.loop_mix;
    cp_.loop_return = p.loop_return;
    cp_.loop_trim = p.loop_trim;
    cp_.loop_latency = p.loop_latency;
  }

  // One pass of the firmware's main loop (about once per millisecond).
  void MainLoopPass(uint32_t now) {
    ReadInputs(now);
    ui_.Update(in_);

    // Automatic loop latency measurement (power-up, S2 Bridge -> Loop).
    if (loop_cal_.Update(ui_.loop_mode(), now)) {
      probe_waiting_ = true;
      probe_due_ms_ = now + kProbeSettleMs;
    }
    if (probe_waiting_ && static_cast<int32_t>(now - probe_due_ms_) >= 0) {
      probe_waiting_ = false;
      probe_.Start();
    }
    if (loop_cal_.measuring() && !probe_waiting_ && probe_.done()) {
      if (!analysing_) {
        analysis_.Begin(probe_);
        analysing_ = true;
      }
      if (analysis_.Step(probe_, kLagsPerPass)) {
        analysing_ = false;
        const LoopProbeResult r = analysis_.Result(probe_);
        const bool used = loop_cal_.OnResult(r.found, r.lag, now);
        if (used) ui_.SetLoopLatency(r.lag);
      }
    }

    BuildChainParams();
    Telemetry(now);
  }

  // The firmware's telemetry schedule: [S] on change (at most 10 per second),
  // [L] and [M] at 20 Hz, [SYS] and [S] once per second.
  void Telemetry(uint32_t now) {
    ++loop_count_;
    if (ui_.revision() != printed_revision_ && now - last_ui_print_ >= 100) {
      char text[telemetry::kBufferSize];
      telemetry::Out o(text, sizeof text);
      telemetry::AppendState(o, ui_);
      if (Emit(o)) {
        printed_revision_ = ui_.revision();
        last_ui_print_ = now;
      }
    }
    if (now - last_live_ >= 50) {
      last_live_ = now;
      ChainMeters m;
      chain_.TakeMeters(&m);
      char text[telemetry::kBufferSize];
      telemetry::Out o(text, sizeof text);
      telemetry::AppendLive(o, in_, ui_, m, raw_knob_, cp_.loop_mode);
      Emit(o);
    }
    if (now - last_report_ >= 1000) {
      telemetry::SysInfo s;
      s.sample_rate = sr_;
      s.block_size = kBlockSize;
      s.cpu_avg = cpu_avg_;
      s.cpu_max = cpu_max_;
      s.loops = loop_count_;
      s.loop_latency = ui_.params().loop_latency;
      s.loop_tries = loop_cal_.tries();
      s.loop_result = loop_cal_.last_result();
      char text[telemetry::kBufferSize];
      telemetry::Out o(text, sizeof text);
      telemetry::AppendSys(o, s);
      telemetry::AppendState(o, ui_);
      if (Emit(o)) {
        last_report_ = now;
        loop_count_ = 0;
      }
    }
  }

  // Appends a message to the pending text; false (dropped) when it does not fit.
  bool Emit(const telemetry::Out& o) {
    if (tel_len_ + o.size() > kTelemetryCap) return false;
    std::memcpy(tel_ + tel_len_, o.c_str(), o.size());
    tel_len_ += o.size();
    return true;
  }

  // One sample of the audio callback plus the wire to the loop pedal.
  float Tick(float x) {
    float send = 0.0f;
    float send_out;
    float out;
    if (probe_.running()) {
      // While measuring, the probe owns the send and the return; the chain
      // sees a silent return so the test noise never reaches OUT L.
      out = chain_.Process(x, 0.0f, &send);
      send_out = probe_.Process(ret_);
    } else {
      out = chain_.Process(x, ret_, &send);
      send_out = send;
    }
    // OUT R -> pedal -> IN R: the return seen at the next sample.
    ret_ = fx_.Process(send_out);
    if (taps_mask_ != 0) {
      const ChainTaps& t = chain_.taps();
      if (taps_mask_ & kTapScope) scope_.Push(x, t.sub, t.up, out);
      if (taps_mask_ & kTapSpectrum) spectrum_.Push(x, t.low, t.high);
    }
    return out;
  }

  // The probe starts this long after the chain was told to run as Bridge, so
  // its 20 ms crossfade is over and the high band plays dry meanwhile.
  static constexpr uint32_t kProbeSettleMs = 30;
  static constexpr int kLagsPerPass = 16;  // 1024 lags: 64 passes, about 64 ms

  int sr_ = 48000;
  float fs_ = 48000.0f;
  uint64_t samples_ = 0;
  int phase_ = 0;
  int64_t last_ms_ = -1;

  UiController ui_;
  UiInputs in_;
  float raw_knob_[6] = {};
  BassChain chain_;
  ChainParams cp_;
  LoopProbe probe_;
  LoopProbe::Analysis analysis_;
  LoopCalibrator loop_cal_;
  bool probe_waiting_ = false;
  uint32_t probe_due_ms_ = 0;
  bool analysing_ = false;
  LoopFxPedal fx_;
  float ret_ = 0.0f;

  char tel_[kTelemetryCap];
  size_t tel_len_ = 0;
  uint32_t last_report_ = 0, last_ui_print_ = 0, printed_revision_ = 0, loop_count_ = 0,
           last_live_ = 0;
  float cpu_avg_ = 0.0f, cpu_max_ = 0.0f;

  int taps_mask_ = 0;
  ScopeTap scope_;
  SpectrumTap spectrum_;
};

}  // namespace virt
}  // namespace bm
