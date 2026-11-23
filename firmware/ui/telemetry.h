// Telemetry text lines ([L] [M] [S] [SYS], and the dev-only [UI] and [RAW]).
// Hardware-free: the firmware (bass_multiband.cpp) and the virtual pedal
// (firmware/virtual) format the lines with the same code, so the web studio
// sees the same text from both. The layout is documented in docs/PROTOCOL.md.
//
// All numbers are integers (no floating point printf on the pedal). Every
// function appends to an `Out` buffer and never writes past it; the text is
// clipped like snprintf does. The caller sends a whole buffer as one message.
#pragma once

#include <cmath>
#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <cstdio>

#include "dsp/bass_chain.h"
#include "ui/pages.h"
#include "ui/ui_controller.h"

namespace bm {
namespace telemetry {

// A buffer that text is appended to. Always NUL terminated.
class Out {
 public:
  Out(char* buf, size_t cap) : buf_(buf), cap_(cap) {
    if (cap_ > 0) buf_[0] = '\0';
  }

#if defined(__GNUC__)
  __attribute__((format(printf, 2, 3)))
#endif
  void Add(const char* fmt, ...) {
    if (cap_ == 0 || len_ + 1 >= cap_) return;
    va_list va;
    va_start(va, fmt);
    const int n = std::vsnprintf(buf_ + len_, cap_ - len_, fmt, va);
    va_end(va);
    if (n <= 0) return;
    const size_t room = cap_ - len_ - 1;
    len_ += static_cast<size_t>(n) < room ? static_cast<size_t>(n) : room;
  }

  const char* c_str() const { return buf_; }
  size_t size() const { return len_; }

 private:
  char* buf_;
  size_t cap_;
  size_t len_ = 0;
};

// Room for every message the firmware composes (the longest is [SYS] + [RAW] +
// [S] in the dev build, about 400 bytes).
constexpr size_t kBufferSize = 768;

inline int Permille(float v) { return static_cast<int>(v * 1000.0f + 0.5f); }

// Level in tenths of a dB (-1200 = silence).
inline int DbX10(float peak) {
  return peak > 1.0e-6f ? static_cast<int>(200.0f * std::log10(peak)) : -1200;
}

// [L] and [M]: live frame for the browser view, 20 times per second: levels,
// raw controls, LEDs, and the compressor gain reduction (gr = high, low; tenths
// of a dB, >= 0). kn = the calibrated pots (what the UI sees), kr = the raw
// readings, pf = the pitch the octaver tracks in tenths of a Hz (0 = no note).
// [M] = levels along the chain for the signal-chain view (peaks in 0.1 dB, see
// ChainMeters): ch/cl compressor outputs, sd send (OUT R), rt return (IN R,
// raw), lp loop mix out, ll low band delayed, up/sb octaves as added to the
// sums, sh/sl sums, ff fuzz feed, do drive out, lw low band out, pc before the
// soft clip, pr after it; og octaver gate, dl loop delay in 0.01 samples,
// el = loop mode the chain really runs (0 while the latency is measured).
inline void AppendLive(Out& o, const UiInputs& in, const UiController& ui, const ChainMeters& m,
                       const float raw_knob[6], int effective_loop_mode) {
  o.Add(
      "[L] in=%d out=%d lo=%d hi=%d kn=%d,%d,%d,%d,%d,%d sw=%d,%d,%d fs=%d,%d ld=%d,%d gr=%d,%d kr=%d,%d,%d,%d,%d,%d pf=%d\r\n"
      "[M] ch=%d cl=%d sd=%d rt=%d lp=%d ll=%d up=%d sb=%d sh=%d sl=%d ff=%d do=%d lw=%d pc=%d pr=%d og=%d dl=%d el=%d\r\n",
      DbX10(m.in), DbX10(m.out), DbX10(m.low), DbX10(m.high),
      Permille(in.knob[0]), Permille(in.knob[1]), Permille(in.knob[2]),
      Permille(in.knob[3]), Permille(in.knob[4]), Permille(in.knob[5]),
      static_cast<int>(in.toggle[0]), static_cast<int>(in.toggle[1]),
      static_cast<int>(in.toggle[2]), ui.footswitch_down(0) ? 1 : 0,
      ui.footswitch_down(1) ? 1 : 0, Permille(ui.led(0)), Permille(ui.led(1)),
      static_cast<int>(m.gr_high * 10.0f + 0.5f), static_cast<int>(m.gr_low * 10.0f + 0.5f),
      Permille(raw_knob[0]), Permille(raw_knob[1]), Permille(raw_knob[2]),
      Permille(raw_knob[3]), Permille(raw_knob[4]), Permille(raw_knob[5]),
      static_cast<int>(m.pitch_hz * 10.0f + 0.5f),
      DbX10(m.comp_high), DbX10(m.comp_low), DbX10(m.send), DbX10(m.ret),
      DbX10(m.loop_out), DbX10(m.low_delayed), DbX10(m.oct_up), DbX10(m.oct_down),
      DbX10(m.sum_high), DbX10(m.sum_low), DbX10(m.fuzz_feed), DbX10(m.drive_out),
      DbX10(m.low_out), DbX10(m.pre_clip), DbX10(m.processed), m.gate ? 1 : 0,
      static_cast<int>(m.loop_delay * 100.0f + 0.5f), effective_loop_mode);
}

// [S]: machine-readable state line for the live view (tools/live_server.py).
// pg/bd/lm/dt = page, band, loop mode, drive type (enum values), oc/dr/by =
// octave on, drive on, bypass, ca = caught mask, tp = takeover pending,
// pm = all stored parameters in permille: master, crossover, comp high
// (thresh, ratio, release, dry/wet), comp low (same), loop (send, mix,
// return, trim), octave (lvl-1, dry/wet, lvl+1, subtone), drive (gain,
// band mix, level, tone).
inline void AppendState(Out& o, const UiController& ui) {
  const Params& p = ui.params();
  o.Add(
      "[S] pg=%d bd=%d lm=%d dt=%d oc=%d dr=%d by=%d ca=%d tp=%d "
      "pm=%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\r\n",
      static_cast<int>(ui.page()), static_cast<int>(ui.band()),
      static_cast<int>(ui.loop_mode()), static_cast<int>(ui.drive_type()),
      p.octave_on ? 1 : 0, p.drive_on ? 1 : 0, ui.bypass() ? 1 : 0,
      ui.caught_mask(), ui.takeover_pending() ? 1 : 0,
      Permille(p.master), Permille(p.crossover),
      Permille(p.comp[0].threshold), Permille(p.comp[0].ratio),
      Permille(p.comp[0].release), Permille(p.comp[0].dry_wet),
      Permille(p.comp[1].threshold), Permille(p.comp[1].ratio),
      Permille(p.comp[1].release), Permille(p.comp[1].dry_wet),
      Permille(p.loop_send), Permille(p.loop_mix),
      Permille(p.loop_return), Permille(p.loop_trim),
      Permille(p.oct_level_down), Permille(p.oct_dry_wet),
      Permille(p.oct_level_up), Permille(p.oct_sub_tone),
      Permille(p.drive_gain), Permille(p.drive_band_mix),
      Permille(p.drive_level), Permille(p.drive_tone));
}

// What the [SYS] line reports (once per second).
struct SysInfo {
  int sample_rate = 48000;
  int block_size = 4;
  float cpu_avg = 0.0f;      // CPU load of the audio callback, 0..1
  float cpu_max = 0.0f;
  uint32_t loops = 0;        // main loop passes since the last [SYS] line
  float loop_latency = 0.0f; // measured, samples (0 = not measured)
  int loop_tries = 0;        // LoopCalibrator::tries()
  int loop_result = -1;      // LoopCalibrator::last_result()
};

// [SYS]: sample rate, block size, CPU load of the audio callback (average and
// peak in 0.1 %), main loop passes in the last second, loop latency (0.01
// samples), automatic loop measurement tries and last result.
inline void AppendSys(Out& o, const SysInfo& s) {
  o.Add("[SYS] sr=%d block=%d cpu avg=%d.%d%% max=%d.%d%% loops=%d lat=%d ltry=%d lres=%d\r\n",
        s.sample_rate, s.block_size, static_cast<int>(s.cpu_avg * 100.0f),
        static_cast<int>(s.cpu_avg * 1000.0f) % 10, static_cast<int>(s.cpu_max * 100.0f),
        static_cast<int>(s.cpu_max * 1000.0f) % 10, static_cast<int>(s.loops),
        static_cast<int>(s.loop_latency * 100.0f + 0.5f), s.loop_tries, s.loop_result);
}

// Dev build only: two human readable [UI] lines (the caller adds the [S] line).
inline void AppendUiLines(Out& o, UiController& ui) {
  const Params& p = ui.params();
  o.Add(
      "[UI] page=%s band=%s loop=%s drive=%s oct=%d drv=%d byp=%d\r\n"
      "[UI] catch=%d%d%d%d M=%d X=%d %s=%d %s=%d %s=%d %s=%d\r\n",
      PageName(ui.page()), BandName(ui.band()), LoopModeName(ui.loop_mode()),
      DriveTypeName(ui.drive_type()), p.octave_on ? 1 : 0, p.drive_on ? 1 : 0,
      ui.bypass() ? 1 : 0, (ui.caught_mask() >> 0) & 1, (ui.caught_mask() >> 1) & 1,
      (ui.caught_mask() >> 2) & 1, (ui.caught_mask() >> 3) & 1, Permille(p.master),
      Permille(p.crossover), SlotName(ui.page(), 0), Permille(ui.StoredSlotValue(0)),
      SlotName(ui.page(), 1), Permille(ui.StoredSlotValue(1)), SlotName(ui.page(), 2),
      Permille(ui.StoredSlotValue(2)), SlotName(ui.page(), 3), Permille(ui.StoredSlotValue(3)));
}

// Dev build only, in the [SYS] message: input peaks in dBFS, raw knobs in
// permille, raw toggles (0 = up, 1 = middle, 2 = down), raw footswitches
// (1 = pressed). `in_l_db`/`in_r_db` come from PeakDb().
inline int PeakDb(float p) { return p > 1.0e-5f ? static_cast<int>(20.0f * std::log10(p)) : -100; }

inline void AppendRaw(Out& o, int in_l_db, int in_r_db, const UiInputs& in) {
  o.Add("[RAW] in L=%d R=%d dBFS | K %d %d %d %d %d %d | S %d %d %d | F %d %d\r\n", in_l_db,
        in_r_db, Permille(in.knob[0]), Permille(in.knob[1]), Permille(in.knob[2]),
        Permille(in.knob[3]), Permille(in.knob[4]), Permille(in.knob[5]),
        static_cast<int>(in.toggle[0]), static_cast<int>(in.toggle[1]),
        static_cast<int>(in.toggle[2]), in.fs[0] ? 1 : 0, in.fs[1] ? 1 : 0);
}

}  // namespace telemetry
}  // namespace bm
