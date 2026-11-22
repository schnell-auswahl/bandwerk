// Remote commands for development builds: the host (tools/pedal_ctl.py) sets
// parameters and states so that measurements do not depend on knob positions.
// Hardware-free; the firmware feeds it the lines received over USB.
//
//   ping
//   set <name|index> <permille>   stored parameter 0..1000 (names: see ParamName)
//   oct on|off      drv on|off      byp on|off
//   page comp|loop|oct|drive
//   dtype od|dist|fuzz            drive type (as switch S3)
//   lmode bridge|loop|inv         loop mode (as switch S2)
//   band high|both|low            compressor band edited on page COMP (as switch S1)
//   defaults                      factory defaults, octave/drive off
//
// The reply is "ok ..." or "err ..." and is sent back as "[CMD] <reply>".
#pragma once

#include <cstdio>
#include <cstring>

#include "line_commands.h"  // devkit
#include "ui/pages.h"
#include "ui/ui_controller.h"

namespace bm {

inline bool ParseOnOff(const char* s, bool* on) {
  if (devkit::Is(s, "on") || devkit::Is(s, "1")) { *on = true; return true; }
  if (devkit::Is(s, "off") || devkit::Is(s, "0")) { *on = false; return true; }
  return false;
}

// `line` is modified. Returns true if the command was understood and applied.
inline bool ApplyDevCommand(UiController& ui, char* line, char* reply, size_t cap) {
  using devkit::Is;
  using devkit::Reply;
  const devkit::Tokens t = devkit::Tokenize(line);
  if (t.n == 0) { Reply(reply, cap, "err", "empty"); return false; }
  bool on = false;

  if (Is(t.t[0], "ping")) { Reply(reply, cap, "ok", "ping"); return true; }

  if (Is(t.t[0], "defaults")) {
    ui.RemoteDefaults();
    Reply(reply, cap, "ok", "defaults");
    return true;
  }

  if (Is(t.t[0], "set")) {
    int permille = 0;
    if (t.n != 3) { Reply(reply, cap, "err", "usage: set <name|index> <permille>"); return false; }
    int idx = ParamIndex(t.t[1]);
    if (idx < 0 && !devkit::ToInt(t.t[1], &idx)) { Reply(reply, cap, "err", "unknown parameter"); return false; }
    if (!devkit::ToInt(t.t[2], &permille) || permille < 0 || permille > 1000) {
      Reply(reply, cap, "err", "value must be 0..1000");
      return false;
    }
    if (!ui.RemoteSetParam(idx, static_cast<float>(permille) * 0.001f)) {
      Reply(reply, cap, "err", "parameter index out of range");
      return false;
    }
    std::snprintf(reply, cap, "ok set %s %d", ParamName(idx), permille);
    return true;
  }

  if (Is(t.t[0], "oct") || Is(t.t[0], "drv") || Is(t.t[0], "byp")) {
    if (t.n != 2 || !ParseOnOff(t.t[1], &on)) { Reply(reply, cap, "err", "usage: oct|drv|byp on|off"); return false; }
    if (Is(t.t[0], "oct")) ui.RemoteSetOctave(on);
    else if (Is(t.t[0], "drv")) ui.RemoteSetDrive(on);
    else ui.RemoteSetBypass(on);
    std::snprintf(reply, cap, "ok %s %s", t.t[0], on ? "on" : "off");
    return true;
  }

  if (Is(t.t[0], "dtype")) {
    DriveType d;
    if (t.n != 2) { Reply(reply, cap, "err", "usage: dtype od|dist|fuzz"); return false; }
    if (Is(t.t[1], "od")) d = DriveType::kOverdrive;
    else if (Is(t.t[1], "dist")) d = DriveType::kDistortion;
    else if (Is(t.t[1], "fuzz")) d = DriveType::kFuzz;
    else { Reply(reply, cap, "err", "unknown drive type"); return false; }
    ui.RemoteSetDriveType(d);
    std::snprintf(reply, cap, "ok dtype %s", t.t[1]);
    return true;
  }

  if (Is(t.t[0], "lmode")) {
    LoopMode m;
    if (t.n != 2) { Reply(reply, cap, "err", "usage: lmode bridge|loop|inv"); return false; }
    if (Is(t.t[1], "bridge")) m = LoopMode::kBridge;
    else if (Is(t.t[1], "loop")) m = LoopMode::kLoop;
    else if (Is(t.t[1], "inv")) m = LoopMode::kLoopInverted;
    else { Reply(reply, cap, "err", "unknown loop mode"); return false; }
    ui.RemoteSetLoopMode(m);
    std::snprintf(reply, cap, "ok lmode %s", t.t[1]);
    return true;
  }

  if (Is(t.t[0], "band")) {
    BandSel bs;
    if (t.n != 2) { Reply(reply, cap, "err", "usage: band high|both|low"); return false; }
    if (Is(t.t[1], "high")) bs = BandSel::kHigh;
    else if (Is(t.t[1], "both")) bs = BandSel::kBoth;
    else if (Is(t.t[1], "low")) bs = BandSel::kLow;
    else { Reply(reply, cap, "err", "unknown band"); return false; }
    ui.RemoteSetBand(bs);
    std::snprintf(reply, cap, "ok band %s", t.t[1]);
    return true;
  }

  if (Is(t.t[0], "page")) {
    Page p;
    if (t.n != 2) { Reply(reply, cap, "err", "usage: page comp|loop|oct|drive"); return false; }
    if (Is(t.t[1], "comp")) p = Page::kComp;
    else if (Is(t.t[1], "loop")) p = Page::kLoop;
    else if (Is(t.t[1], "oct")) p = Page::kOctave;
    else if (Is(t.t[1], "drive")) p = Page::kDrive;
    else { Reply(reply, cap, "err", "unknown page"); return false; }
    ui.RemoteGoToPage(p);
    std::snprintf(reply, cap, "ok page %s", t.t[1]);
    return true;
  }

  Reply(reply, cap, "err", "unknown command");
  return false;
}

}  // namespace bm
