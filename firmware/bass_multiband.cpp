// BassMultiband for Hothouse DIY DSP Platform
// Copyright (C) 2026 schnell-auswahl
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

// ### Uncomment if IntelliSense can't resolve DaisySP-LGPL classes ###
// #include "daisysp-lgpl.h"

#include <cmath>
#include <cstdarg>
#include <cstdio>

#include "daisysp.h"
#include "dsp/bass_chain.h"
#include "dsp/loop_probe.h"
#include "hothouse.h"
#include "ui/dfu_gesture.h"
#include "ui/knob_calibration.h"
#include "ui/loop_calibration.h"
#include "ui/settings.h"
#include "ui/settings_store.h"
#include "ui/ui_controller.h"
#include "version.h"
// BM_REMOTE (default on, `make BM_REMOTE=0` strips it): USB serial link with
// telemetry and remote commands, in the dev and the release build
// (docs/PROTOCOL.md). BM_DEV adds the development extras on top of it.
#if defined(BM_DEV) && !defined(BM_REMOTE)
#error "BM_DEV needs BM_REMOTE (the dev extras use the USB serial link)"
#endif
#ifdef BM_REMOTE
#include "dev_link.h"           // devkit/firmware
#include "ui/dev_commands.h"
#endif
#include "util/CpuLoadMeter.h"
#include "sys/dma.h"

using clevelandmusicco::Hothouse;
using daisy::AudioHandle;
using daisy::CpuLoadMeter;
using daisy::Led;
using daisy::SaiHandle;
using daisy::System;

namespace {

constexpr size_t kBlockSize = 4;

// FS1 + FS2 global bypass gesture. It toggles the global bypass (IN L routed
// straight to OUT L, both LEDs off).
constexpr bool kEnableBypassGesture = true;

Hothouse hw;
Led led_1, led_2;
CpuLoadMeter cpu_load;
bm::UiController ui;
bm::BassChain chain;
bm::DfuGesture dfu_gesture;

// Saved settings live at the start of the QSPI chip (with the Daisy bootloader
// the program starts at 0x40000, so the first 256 KB are free). ui/settings_store.h
// appends records over 8 sectors (wear leveling).
struct QspiFlash {
  const uint8_t* Data() {
    void* p = hw.seed.qspi.GetData(0);
    // The flash is read through the memory-mapped window; drop stale cache lines after writes.
    dsy_dma_invalidate_cache_for_buffer(static_cast<uint8_t*>(p), bm::kStoreBytes);
    return static_cast<const uint8_t*>(p);
  }
  bool EraseSector(uint32_t sector) {
    const uint32_t a = sector * bm::kStoreSectorBytes;
    return hw.seed.qspi.Erase(a, a + bm::kStoreSectorBytes) == daisy::QSPIHandle::Result::OK;
  }
  bool Write(uint32_t offset, const uint8_t* p, uint32_t n) {
    return hw.seed.qspi.Write(offset, n, const_cast<uint8_t*>(p)) == daisy::QSPIHandle::Result::OK;
  }
};
QspiFlash qspi_flash;
bm::SettingsStore<QspiFlash> settings_store(&qspi_flash);
bm::SaveScheduler save_scheduler;

// Parameters handed from the main loop (UI) to the audio callback. Each field
// is a single aligned 32-bit value, so reads and writes are atomic; the audio
// side smooths everything, so a mix of old and new values is harmless.
struct SharedParams {
  volatile float master = 0.5f;
  volatile float crossover = 0.5f;
  volatile float band_mix = 0.5f;
  volatile bool bypass = false;
  // [band][threshold, ratio, release, dry/wet], band 0 = high, 1 = low
  volatile float comp[2][4] = {{0.647f, 0.414f, 0.463f, 0.6f},
                               {0.471f, 0.431f, 0.528f, 1.0f}};
  // octaver: level -1, dry/wet, level +1, sub tone
  volatile bool octave_on = false;
  volatile float oct[4] = {0.5f, 0.5f, 0.5f, 0.5f};
  // drive: on, type (0 overdrive, 1 distortion, 2 fuzz), gain, level, tone
  volatile bool drive_on = false;
  volatile int drive_type = 1;
  volatile float drive[3] = {0.5f, 0.5f, 0.5f};
  // FX loop: mode (0 bridge, 1 loop, 2 loop + phase invert), send, mix, return, trim
  volatile int loop_mode = 0;
  volatile float loop[4] = {0.5f, 1.0f, 0.5f, 0.5f};
  volatile float loop_latency = 0.0f;  // measured, samples (0 = not measured)
};
SharedParams g_shared;

#ifdef BM_DEV
// Input peak per channel, written by the audio callback and read/reset by the
// main loop (a benign race: only used for the serial diagnostics).
volatile float g_in_peak[2] = {0.0f, 0.0f};
#endif

#ifdef BM_DIAG_TONE
float g_phase_l = 0.0f;
float g_phase_r = 0.0f;
#endif

// Measures the FX loop: automatically (LoopCalibrator) and on request (dev
// command `looptest`).
bm::LoopProbe loop_probe;
bm::LoopCalibrator loop_cal;
// The probe starts this long after the chain was told to run as Bridge, so
// its 20 ms crossfade is over and the high band plays dry meanwhile.
constexpr uint32_t kProbeSettleMs = 30;

// IN L (bass) -> BassChain -> OUT L (pedal out, tip of the OUT jack). A plain
// TS cable on the OUT jack therefore carries the pedal output. OUT R is the FX
// send, IN R the FX return (both on the ring: TRS insert cables). In Bridge
// (S2 up) the send is silent and the return is ignored.
void AudioCallback(AudioHandle::InputBuffer in, AudioHandle::OutputBuffer out,
                   size_t size) {
  cpu_load.OnBlockStart();

  // Knobs and switches are read once per block (the knob smoothing in
  // Hothouse is tuned to the callback rate). Also required for the
  // FS1 + FS2 DFU gesture, which needs the switches debounced.
  hw.ProcessAllControls();

  bm::ChainParams cp;
  cp.master = g_shared.master;
  cp.crossover = g_shared.crossover;
  cp.band_mix = g_shared.band_mix;
  cp.bypass = g_shared.bypass;
  for (int b = 0; b < 2; ++b) {
    cp.comp[b] = {g_shared.comp[b][0], g_shared.comp[b][1], g_shared.comp[b][2],
                  g_shared.comp[b][3]};
  }
  cp.octave_on = g_shared.octave_on;
  cp.oct_level_down = g_shared.oct[0];
  cp.oct_dry_wet = g_shared.oct[1];
  cp.oct_level_up = g_shared.oct[2];
  cp.oct_sub_tone = g_shared.oct[3];
  cp.drive_on = g_shared.drive_on;
  cp.drive_type = g_shared.drive_type;
  cp.drive_gain = g_shared.drive[0];
  cp.drive_level = g_shared.drive[1];
  cp.drive_tone = g_shared.drive[2];
  cp.loop_mode = g_shared.loop_mode;
  cp.loop_send = g_shared.loop[0];
  cp.loop_mix = g_shared.loop[1];
  cp.loop_return = g_shared.loop[2];
  cp.loop_trim = g_shared.loop[3];
  cp.loop_latency = g_shared.loop_latency;
  chain.SetParams(cp);

  for (size_t i = 0; i < size; ++i) {
#ifdef BM_DIAG_TONE
    out[0][i] = 0.1f * sinf(6.2831853f * g_phase_l);
    out[1][i] = 0.1f * sinf(6.2831853f * g_phase_r);
    g_phase_l += 1000.0f / 48000.0f;
    g_phase_r += 500.0f / 48000.0f;
    if (g_phase_l >= 1.0f) g_phase_l -= 1.0f;
    if (g_phase_r >= 1.0f) g_phase_r -= 1.0f;
#else
    float send = 0.0f;
    if (loop_probe.running()) {
      // While measuring, the probe owns the send and the return; the chain
      // sees a silent return so the test noise never reaches OUT L.
      out[0][i] = chain.Process(in[0][i], 0.0f, &send);
      out[1][i] = loop_probe.Process(in[1][i]);
    } else {
      out[0][i] = chain.Process(in[0][i], in[1][i], &send);
      out[1][i] = send;
    }
#endif
#ifdef BM_DEV
    const float a0 = fabsf(in[0][i]);
    const float a1 = fabsf(in[1][i]);
    if (a0 > g_in_peak[0]) g_in_peak[0] = a0;
    if (a1 > g_in_peak[1]) g_in_peak[1] = a1;
#endif
  }

  // Software PWM of the LEDs runs at the callback rate (brightness is set by
  // the main loop).
  led_1.Update();
  led_2.Update();

  cpu_load.OnBlockEnd();
}

// Blink both LEDs a few times so the user can see that the firmware started.
void StartupBlink() {
  for (int i = 0; i < 3; ++i) {
    led_1.Set(1.0f);
    led_2.Set(1.0f);
    led_1.Update();
    led_2.Update();
    hw.DelayMs(120);
    led_1.Set(0.0f);
    led_2.Set(0.0f);
    led_1.Update();
    led_2.Update();
    hw.DelayMs(120);
  }
}

// Same visible announcement as Hothouse::CheckResetToBootloader(): alternate
// the LEDs three times, then jump into the bootloader.
void EnterBootloader() {
  hw.StopAdc();
  hw.StopAudio();
  for (int i = 0; i < 3; ++i) {
    led_1.Set(1.0f);
    led_2.Set(0.0f);
    led_1.Update();
    led_2.Update();
    hw.DelayMs(100);
    led_1.Set(0.0f);
    led_2.Set(1.0f);
    led_1.Update();
    led_2.Update();
    hw.DelayMs(100);
  }
#ifdef BOOT_APP
  // APP_TYPE=BOOT_SRAM (release and dev): the Daisy bootloader is installed. Stay
  // in its DFU mode until a new program is flashed (power-cycling gets back to the
  // program).
  System::ResetToBootloader(System::BootloaderMode::DAISY_INFINITE_TIMEOUT);
#else
  // APP_TYPE=BOOT_NONE (emergency layout): STM32 ROM bootloader. (DAISY_* would
  // return without doing anything, since no Daisy bootloader is running.)
  System::ResetToBootloader(System::BootloaderMode::STM);
#endif
}

bm::TogglePos ToTogglePos(Hothouse::ToggleswitchPosition p) {
  switch (p) {
    case Hothouse::TOGGLESWITCH_UP: return bm::TogglePos::kUp;
    case Hothouse::TOGGLESWITCH_DOWN: return bm::TogglePos::kDown;
    default: return bm::TogglePos::kMiddle;
  }
}

// How the settings came up at power-up (telemetry [SYS]).
bool g_boot_loaded = false;  // valid saved settings were used

// Raw pot readings before the calibration (telemetry "kr", tools/knob_range.py).
float g_raw_knob[6] = {0, 0, 0, 0, 0, 0};

void ReadInputs(bm::UiInputs* in) {
  for (int i = 0; i < 6; ++i) {
    g_raw_knob[i] = hw.GetKnobValue(static_cast<Hothouse::Knob>(i));
    in->knob[i] = bm::NormalizeKnob(i, g_raw_knob[i]);
  }
  in->toggle[0] = ToTogglePos(hw.GetToggleswitchPosition(Hothouse::TOGGLESWITCH_1));
  in->toggle[1] = ToTogglePos(hw.GetToggleswitchPosition(Hothouse::TOGGLESWITCH_2));
  in->toggle[2] = ToTogglePos(hw.GetToggleswitchPosition(Hothouse::TOGGLESWITCH_3));
  in->fs[0] = hw.switches[Hothouse::FOOTSWITCH_1].Pressed();
  in->fs[1] = hw.switches[Hothouse::FOOTSWITCH_2].Pressed();
  in->now_ms = System::GetNow();
}

#ifdef BM_REMOTE
int Permille(float v) { return static_cast<int>(v * 1000.0f + 0.5f); }

// Non-blocking USB link to the host (log out, commands in): devkit/firmware.
// Never waits for the host, so it is safe on stage without a computer.
devkit::DevLink dev_log;

// What `hello` reports (docs/PROTOCOL.md).
bm::BuildInfo MakeBuildInfo() {
  bm::BuildInfo b;
  b.fw = BM_FW_VERSION;
  b.proto = BM_PROTO_VERSION;
#ifdef BM_DEV
  b.build = "dev";
#else
  b.build = "release";
#endif
#ifdef BOOT_APP
  b.app = "boot_sram";
#else
  b.app = "boot_none";
#endif
  return b;
}

// Machine-readable state line for the live view (tools/live_server.py).
// pg/bd/lm/dt = page, band, loop mode, drive type (enum values), oc/dr/by =
// octave on, drive on, bypass, ca = caught mask, tp = takeover pending,
// pm = all stored parameters in permille: master, crossover, comp high
// (thresh, ratio, release, dry/wet), comp low (same), loop (send, mix,
// return, trim), octave (lvl-1, dry/wet, lvl+1, subtone), drive (gain,
// band mix, level, tone).
#define BM_STATE_FMT                                                      \
  "[S] pg=%d bd=%d lm=%d dt=%d oc=%d dr=%d by=%d ca=%d tp=%d "            \
  "pm=%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\r\n"
#define BM_STATE_ARGS(p)                                                   \
  static_cast<int>(ui.page()), static_cast<int>(ui.band()),               \
      static_cast<int>(ui.loop_mode()), static_cast<int>(ui.drive_type()), \
      (p).octave_on ? 1 : 0, (p).drive_on ? 1 : 0, ui.bypass() ? 1 : 0,   \
      ui.caught_mask(), ui.takeover_pending() ? 1 : 0,                    \
      Permille((p).master), Permille((p).crossover),                      \
      Permille((p).comp[0].threshold), Permille((p).comp[0].ratio),       \
      Permille((p).comp[0].release), Permille((p).comp[0].dry_wet),       \
      Permille((p).comp[1].threshold), Permille((p).comp[1].ratio),       \
      Permille((p).comp[1].release), Permille((p).comp[1].dry_wet),       \
      Permille((p).loop_send), Permille((p).loop_mix),                    \
      Permille((p).loop_return), Permille((p).loop_trim),                 \
      Permille((p).oct_level_down), Permille((p).oct_dry_wet),            \
      Permille((p).oct_level_up), Permille((p).oct_sub_tone),             \
      Permille((p).drive_gain), Permille((p).drive_band_mix),             \
      Permille((p).drive_level), Permille((p).drive_tone)

// Once per second: sample rate, block size, CPU load of the audio callback
// (average and peak in 0.1 %), main loop passes in the last second, loop
// latency (0.01 samples), automatic loop measurement tries and last result.
#define BM_SYS_FMT \
  "[SYS] sr=%d block=%d cpu avg=%d.%d%% max=%d.%d%% loops=%d lat=%d ltry=%d lres=%d\r\n"
#define BM_SYS_ARGS(loops)                                                   \
  static_cast<int>(hw.AudioSampleRate()), static_cast<int>(hw.AudioBlockSize()), \
      static_cast<int>(cpu_load.GetAvgCpuLoad() * 100.0f),                   \
      static_cast<int>(cpu_load.GetAvgCpuLoad() * 1000.0f) % 10,             \
      static_cast<int>(cpu_load.GetMaxCpuLoad() * 100.0f),                   \
      static_cast<int>(cpu_load.GetMaxCpuLoad() * 1000.0f) % 10,             \
      static_cast<int>(loops),                                               \
      static_cast<int>(ui.params().loop_latency * 100.0f + 0.5f), loop_cal.tries(), \
      loop_cal.last_result()

// Level in tenths of a dB (-1200 = silence).
int DbX10(float peak) {
  return peak > 1.0e-6f ? static_cast<int>(200.0f * log10f(peak)) : -1200;
}

// Live telemetry, 20 times per second: levels, raw controls, LEDs, and the
// compressor gain reduction (gr = high, low; tenths of a dB, >= 0). kn = the
// calibrated pots (what the UI sees), kr = the raw readings, pf = the pitch the
// octaver tracks in tenths of a Hz (0 = no note).
// [M] = levels along the chain for the signal-chain view (peaks in 0.1 dB,
// see ChainMeters): ch/cl compressor outputs, sd send (OUT R), rt return (IN R,
// raw), lp loop mix out, ll low band delayed, up/sb octaves as added to the
// sums, sh/sl sums, ff fuzz feed, do drive out, lw low band out, pc before the
// soft clip, pr after it; og octaver gate, dl loop delay in 0.01 samples,
// el = loop mode the chain really runs (0 while the latency is measured).
void PrintLiveFrame(const bm::UiInputs& in) {
  bm::ChainMeters m;
  chain.TakeMeters(&m);
  dev_log.Print(
      "[L] in=%d out=%d lo=%d hi=%d kn=%d,%d,%d,%d,%d,%d sw=%d,%d,%d fs=%d,%d ld=%d,%d gr=%d,%d kr=%d,%d,%d,%d,%d,%d pf=%d\r\n"
      "[M] ch=%d cl=%d sd=%d rt=%d lp=%d ll=%d up=%d sb=%d sh=%d sl=%d ff=%d do=%d lw=%d pc=%d pr=%d og=%d dl=%d el=%d\r\n",
      DbX10(m.in), DbX10(m.out), DbX10(m.low), DbX10(m.high),
      Permille(in.knob[0]), Permille(in.knob[1]), Permille(in.knob[2]),
      Permille(in.knob[3]), Permille(in.knob[4]), Permille(in.knob[5]),
      static_cast<int>(in.toggle[0]), static_cast<int>(in.toggle[1]),
      static_cast<int>(in.toggle[2]), ui.footswitch_down(0) ? 1 : 0,
      ui.footswitch_down(1) ? 1 : 0, Permille(ui.led(0)), Permille(ui.led(1)),
      static_cast<int>(m.gr_high * 10.0f + 0.5f), static_cast<int>(m.gr_low * 10.0f + 0.5f),
      Permille(g_raw_knob[0]), Permille(g_raw_knob[1]), Permille(g_raw_knob[2]),
      Permille(g_raw_knob[3]), Permille(g_raw_knob[4]), Permille(g_raw_knob[5]),
      static_cast<int>(m.pitch_hz * 10.0f + 0.5f),
      DbX10(m.comp_high), DbX10(m.comp_low), DbX10(m.send), DbX10(m.ret),
      DbX10(m.loop_out), DbX10(m.low_delayed), DbX10(m.oct_up), DbX10(m.oct_down),
      DbX10(m.sum_high), DbX10(m.sum_low), DbX10(m.fuzz_feed), DbX10(m.drive_out),
      DbX10(m.low_out), DbX10(m.pre_clip), DbX10(m.processed), m.gate ? 1 : 0,
      static_cast<int>(m.loop_delay * 100.0f + 0.5f), static_cast<int>(g_shared.loop_mode));
}

#ifdef BM_DEV
// Two human readable lines plus the state line whenever the UI state changed.
bool PrintUiState() {
  const bm::Params& p = ui.params();
  return dev_log.Print(
      "[UI] page=%s band=%s loop=%s drive=%s oct=%d drv=%d byp=%d\r\n"
      "[UI] catch=%d%d%d%d M=%d X=%d %s=%d %s=%d %s=%d %s=%d\r\n" BM_STATE_FMT,
      bm::PageName(ui.page()), bm::BandName(ui.band()),
      bm::LoopModeName(ui.loop_mode()), bm::DriveTypeName(ui.drive_type()),
      p.octave_on ? 1 : 0, p.drive_on ? 1 : 0, ui.bypass() ? 1 : 0,
      (ui.caught_mask() >> 0) & 1, (ui.caught_mask() >> 1) & 1,
      (ui.caught_mask() >> 2) & 1, (ui.caught_mask() >> 3) & 1,
      Permille(p.master), Permille(p.crossover),
      bm::SlotName(ui.page(), 0), Permille(ui.StoredSlotValue(0)),
      bm::SlotName(ui.page(), 1), Permille(ui.StoredSlotValue(1)),
      bm::SlotName(ui.page(), 2), Permille(ui.StoredSlotValue(2)),
      bm::SlotName(ui.page(), 3), Permille(ui.StoredSlotValue(3)),
      BM_STATE_ARGS(p));
}
#else
// Release: only the machine-readable state line.
bool PrintUiState() {
  const bm::Params& p = ui.params();
  return dev_log.Print(BM_STATE_FMT, BM_STATE_ARGS(p));
}
#endif  // BM_DEV
#endif  // BM_REMOTE

}  // namespace

void SaveSettings(const bm::Settings& cur) {
#ifndef BM_DEV
  settings_store.Save(cur);
#else
  const bool ok = settings_store.Save(cur);
  dev_log.Print("[SAVE] settings %s (slot %d, %d so far)\r\n", ok ? "written" : "FAILED",
                static_cast<int>(settings_store.newest_slot()), static_cast<int>(save_scheduler.saves()));
#endif
}

int main() {
  hw.Init();
  // Set the sample rate first: it re-initializes the audio engine.
  hw.SetAudioSampleRate(SaiHandle::Config::SampleRate::SAI_48KHZ);
  hw.SetAudioBlockSize(kBlockSize);

#ifdef BM_REMOTE
  dev_log.Init();  // non-blocking: works with or without a host
#endif

  led_1.Init(hw.seed.GetPin(Hothouse::LED_1), false, hw.AudioCallbackRate());
  led_2.Init(hw.seed.GetPin(Hothouse::LED_2), false, hw.AudioCallbackRate());
  StartupBlink();

  cpu_load.Init(hw.AudioSampleRate(), static_cast<int>(hw.AudioBlockSize()));
  chain.Init(hw.AudioSampleRate(), bm::ChainParams());

  hw.StartAdc();
  hw.StartAudio(AudioCallback);

  // Let the knob smoothing settle before the UI takes over the positions.
  hw.DelayMs(100);
  {
    bm::UiInputs in;
    ReadInputs(&in);
    bm::UiConfig cfg;
    cfg.bypass_gesture_enabled = kEnableBypassGesture;
    // Stored settings. The master follows its knob; the crossover starts at the
    // stored value until its knob is moved. The pedal starts on the DRIVE page.
    bm::Params start;
    bm::Settings stored;
    g_boot_loaded = settings_store.Load(&stored) && bm::UnpackSettings(stored, &start);
    save_scheduler.Init(g_boot_loaded ? stored : bm::PackSettings(start), in.now_ms);
    cfg.restore_crossover = g_boot_loaded;
    cfg.start_page = bm::Page::kDrive;
    ui.Init(in, start, cfg);
    loop_cal.Init(ui.loop_mode(), in.now_ms);
  }
  bool probe_waiting = false;  // automatic measurement: chain switched to Bridge, probe not started yet
  uint32_t probe_due_ms = 0;

#ifdef BM_REMOTE
  const bm::BuildInfo build_info = MakeBuildInfo();
  uint32_t last_report = System::GetNow();
  uint32_t last_ui_print = 0;
  uint32_t printed_revision = 0;
  uint32_t loop_count = 0;  // main loop passes since the last [SYS] line
  uint32_t last_live = 0;
#endif
#ifdef BM_DEV
  bool boot_reported = false;
#endif

  while (true) {
    hw.DelayMs(1);

#ifdef BM_REMOTE
    // Remote commands from the host (web studio, tools/pedal_ctl.py). Only taken
    // when the reply can be sent right away; handled before the UI update so the
    // new values are in effect within this pass.
    {
      char cmd[devkit::DevLink::kLineSize];
      char reply[96];
      if (dev_log.CanPrint() && dev_log.PopLine(cmd, sizeof cmd)) {
#ifdef BM_DEV
        // Dev-only commands that need the hardware (storage, reset, loop probe).
        if (devkit::Is(cmd, "reboot")) {
          dev_log.Print("[CMD] ok reboot\r\n");
          dev_log.Flush(100);  // bounded: gives up after 100 ms if nobody reads
          hw.DelayMs(50);
          NVIC_SystemReset();  // plain restart: the bootloader starts the program again
        } else if (devkit::Is(cmd, "looptest") && loop_cal.measuring()) {
          dev_log.Print("[CMD] err looptest busy (automatic measurement running)\r\n");
        } else if (devkit::Is(cmd, "looptest")) {
          // Blocks the main loop for ~0.1 s: noise burst on the send, record the
          // return, cross-correlate. Lag in 1/100 samples, levels in 1/10 dB.
          loop_probe.Start();
          while (!loop_probe.done()) hw.DelayMs(1);
          const bm::LoopProbeResult r = loop_probe.Analyze();
          dev_log.Print("[CMD] ok looptest found=%d lag=%d gain=%d coef=%d inv=%d ret=%d rt=%d\r\n",
                        r.found ? 1 : 0, static_cast<int>(r.lag * 100.0f + 0.5f),
                        static_cast<int>(r.gain_db * 10.0f), static_cast<int>(r.coef * 1000.0f),
                        r.inverted ? 1 : 0, static_cast<int>(r.return_rms_db * 10.0f),
                        static_cast<int>(bm::kLoopRoundTripSamples * 100.0f));
        } else if (devkit::Is(cmd, "save")) {
          SaveSettings(bm::PackSettings(ui.params()));
          dev_log.Print("[CMD] ok save\r\n");
        } else if (devkit::Is(cmd, "wipe")) {
          const bool ok = settings_store.EraseAll();  // running state is unchanged
          dev_log.Print("[CMD] %s wipe\r\n", ok ? "ok" : "err");
        } else
#endif
        {
          bm::RemoteAction action = bm::RemoteAction::kNone;
          bm::ApplyDevCommand(ui, cmd, reply, sizeof reply, build_info, &action);
          dev_log.Print("[CMD] %s\r\n", reply);
          if (action == bm::RemoteAction::kEnterBootloader) {
            // Same as holding FS1 + FS2: lets the host flash without touching the
            // pedal. Reply first: hand it to the USB driver (bounded wait), then
            // give the host 50 ms to read it before the USB port disappears.
            dev_log.Flush(100);
            hw.DelayMs(50);
            EnterBootloader();
          }
        }
      }
    }
#endif

    bm::UiInputs in;
    ReadInputs(&in);
    ui.Update(in);
    // Automatic loop latency measurement (power-up, S2 Bridge -> Loop).
    if (loop_cal.Update(ui.loop_mode(), in.now_ms)) {
      probe_waiting = true;
      probe_due_ms = in.now_ms + kProbeSettleMs;
    }
    if (probe_waiting && static_cast<int32_t>(in.now_ms - probe_due_ms) >= 0) {
      probe_waiting = false;
      loop_probe.Start();
    }
    if (loop_cal.measuring() && !probe_waiting && loop_probe.done()) {
      const bm::LoopProbeResult r = loop_probe.Analyze();
      const bool used = loop_cal.OnResult(r.found, r.lag, System::GetNow());
      if (used) ui.SetLoopLatency(r.lag);
#ifdef BM_DEV
      dev_log.Print("[LOOP] auto try=%d found=%d lag=%d coef=%d used=%d\r\n", loop_cal.tries(),
                    r.found ? 1 : 0, static_cast<int>(r.lag * 100.0f + 0.5f),
                    static_cast<int>(r.coef * 1000.0f), used ? 1 : 0);
#endif
    }

    led_1.Set(ui.led(0));
    {
      float level;
      if (loop_cal.Led(in.now_ms, &level)) led_1.Set(level);  // failed measurement
    }
    led_2.Set(ui.led(1));

    // Hand the parameters over to the audio callback.
    g_shared.master = ui.params().master;
    g_shared.crossover = ui.params().crossover;
    g_shared.band_mix = ui.params().drive_band_mix;
    g_shared.bypass = ui.bypass();
    g_shared.drive_on = ui.params().drive_on;
    g_shared.drive_type = static_cast<int>(ui.drive_type());
    g_shared.drive[0] = ui.params().drive_gain;
    g_shared.drive[1] = ui.params().drive_level;
    g_shared.drive[2] = ui.params().drive_tone;
    g_shared.octave_on = ui.params().octave_on;
    g_shared.oct[0] = ui.params().oct_level_down;
    g_shared.oct[1] = ui.params().oct_dry_wet;
    g_shared.oct[2] = ui.params().oct_level_up;
    g_shared.oct[3] = ui.params().oct_sub_tone;
    // While measuring, the chain runs as Bridge (high band dry, nothing lost on OUT L).
    g_shared.loop_mode = loop_cal.measuring() ? 0 : static_cast<int>(ui.loop_mode());
    g_shared.loop_latency = ui.params().loop_latency;
    g_shared.loop[0] = ui.params().loop_send;
    g_shared.loop[1] = ui.params().loop_mix;
    g_shared.loop[2] = ui.params().loop_return;
    g_shared.loop[3] = ui.params().loop_trim;
    for (int b = 0; b < 2; ++b) {
      const bm::CompParams& c = ui.params().comp[b];
      g_shared.comp[b][0] = c.threshold;
      g_shared.comp[b][1] = c.ratio;
      g_shared.comp[b][2] = c.release;
      g_shared.comp[b][3] = c.dry_wet;
    }

    // Save when the settings have not changed for 3 s. Flash writes block for
    // some ms, so this runs here and never in the audio callback.
    {
      const bm::Settings cur = bm::PackSettings(ui.params());
      if (save_scheduler.Update(cur, in.now_ms)) SaveSettings(cur);
    }

    // FS1 + FS2 held for 2 s starts the DFU bootloader. Our own gesture works
    // on debounced states and tolerates short dropouts; the library check
    // stays as a fallback.
#ifdef BM_DEV
    const bool dfu_was_active = dfu_gesture.active();
    const uint32_t dfu_held = dfu_gesture.held_ms(in.now_ms);
#endif
    if (dfu_gesture.Update(ui.footswitch_down(0), ui.footswitch_down(1),
                           in.now_ms)) {
      EnterBootloader();
    }
#ifdef BM_DEV
    if (!dfu_was_active && dfu_gesture.active()) {
      dev_log.Print("[DFU] both footswitches down\r\n");
    } else if (dfu_was_active && !dfu_gesture.active()) {
      dev_log.Print("[DFU] gesture ended after %d ms\r\n", static_cast<int>(dfu_held));
    }
#endif
#ifndef BOOT_APP
    // Library fallback: it jumps into the STM32 ROM bootloader, which cannot write the
    // QSPI chip, so it is only used for the internal-flash layout.
    hw.CheckResetToBootloader();
#endif

#ifdef BM_REMOTE
    // Telemetry. Every print below is skipped (not queued, not even formatted)
    // while the USB driver still holds the previous message, i.e. when no host
    // reads: then all of this costs a few dozen cycles per pass.
    const uint32_t now = System::GetNow();
    ++loop_count;
    dev_log.Pump();
#ifdef BM_DEV
    if (!boot_reported && dev_log.CanPrint()) {
      boot_reported = dev_log.Print("[BOOT] settings: %s\r\n",
                                    g_boot_loaded ? "loaded" : "defaults (nothing valid saved)");
    }
#endif

    // UI state: print on change, at most 10 times per second. The revision
    // is only marked as printed when the message was really handed over.
    if (ui.revision() != printed_revision && now - last_ui_print >= 100 && dev_log.CanPrint()) {
      if (PrintUiState()) {
        printed_revision = ui.revision();
        last_ui_print = now;
      }
    }

    // Live frame for the browser view, 20 Hz. Skipped (not queued) when the
    // USB port is busy, so the meters stay current.
    if (now - last_live >= 50 && dev_log.CanPrint()) {
      last_live = now;
      PrintLiveFrame(in);
    }

    if (now - last_report >= 1000 && dev_log.CanPrint()) {
#ifdef BM_DEV
      // Input peaks in dBFS, raw knobs in permille, raw toggles
      // (0 = up, 1 = middle, 2 = down), raw footswitches (1 = pressed).
      auto peak_db = [](float p) {
        return p > 1.0e-5f ? static_cast<int>(20.0f * log10f(p)) : -100;
      };
      const int in_l = peak_db(g_in_peak[0]);
      const int in_r = peak_db(g_in_peak[1]);
      // Integer output only: printf float support is not linked in.
      const bool printed = dev_log.Print(
          BM_SYS_FMT
          "[RAW] in L=%d R=%d dBFS | K %d %d %d %d %d %d | S %d %d %d | F %d %d\r\n"
          BM_STATE_FMT,
          BM_SYS_ARGS(loop_count), in_l, in_r, Permille(in.knob[0]), Permille(in.knob[1]),
          Permille(in.knob[2]), Permille(in.knob[3]), Permille(in.knob[4]),
          Permille(in.knob[5]), static_cast<int>(in.toggle[0]),
          static_cast<int>(in.toggle[1]), static_cast<int>(in.toggle[2]),
          in.fs[0] ? 1 : 0, in.fs[1] ? 1 : 0, BM_STATE_ARGS(ui.params()));
#else
      const bool printed =
          dev_log.Print(BM_SYS_FMT BM_STATE_FMT, BM_SYS_ARGS(loop_count), BM_STATE_ARGS(ui.params()));
#endif
      if (printed) {
        last_report = now;
        loop_count = 0;
#ifdef BM_DEV
        g_in_peak[0] = 0.0f;
        g_in_peak[1] = 0.0f;
#endif
        cpu_load.Reset();
      }
    }
#endif
  }
  return 0;
}
