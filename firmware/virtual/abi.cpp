// C ABI of the virtual pedal (docs/VIRTUAL.md). One pedal instance; the host
// (the AudioWorklet, or the native test driver) calls these functions and
// exchanges data through fixed buffers whose addresses it asks for once.
//
// Built as WebAssembly (Emscripten, standalone: no JavaScript glue) and as a
// plain native object for the host tests, from the same source.
#include <cstddef>
#include <cstdint>
#include <cstring>

#include "virtual/virtual_pedal.h"

#if defined(__EMSCRIPTEN__)
#include <emscripten.h>
#define VP_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define VP_EXPORT extern "C"
#endif

namespace {

constexpr int kMaxFrames = 1024;     // largest vp_process() call
constexpr int kScopeStride = 1024;   // points per channel in the scope buffer
constexpr size_t kTextCap = 128;     // command line in / reply out
constexpr size_t kLinesCap = 4096;   // telemetry text out

bm::virt::VirtualPedal g_pedal;
float g_in[kMaxFrames];
float g_out[kMaxFrames];
char g_text[kTextCap];
char g_reply[kTextCap];
char g_lines[kLinesCap];
float g_scope[bm::virt::kScopeChannels * kScopeStride];
float g_spectrum[bm::virt::kSpecSignals * bm::virt::kSpecBands];
bool g_ready = false;

}  // namespace

// Version of this interface. Bump when a function changes meaning.
VP_EXPORT int vp_abi_version(void) { return 1; }

// (Re)starts the pedal as after a power cycle. Returns 0 (1 for a bad rate).
VP_EXPORT int vp_init(int sample_rate) {
  if (sample_rate < 8000 || sample_rate > 192000) return 1;
  g_pedal.Init(sample_rate);
  g_ready = true;
  return 0;
}

// Audio: write n mono samples to vp_in_ptr(), call vp_process(n), read n
// samples from vp_out_ptr(). n up to vp_max_frames(); any n is allowed.
VP_EXPORT int vp_max_frames(void) { return kMaxFrames; }
VP_EXPORT float* vp_in_ptr(void) { return g_in; }
VP_EXPORT float* vp_out_ptr(void) { return g_out; }
VP_EXPORT void vp_process(int n) {
  if (!g_ready) return;
  if (n < 0) n = 0;
  if (n > kMaxFrames) n = kMaxFrames;
  g_pedal.Process(g_in, g_out, n);
}

// Commands: write a NUL terminated line (without line ending, at most 95
// characters) to vp_text_ptr(), call vp_command(); returns 1 for "ok ...", 0
// for "err ...". The reply text (without the "[CMD] " tag) is at vp_reply_ptr().
VP_EXPORT char* vp_text_ptr(void) { return g_text; }
VP_EXPORT const char* vp_reply_ptr(void) { return g_reply; }
VP_EXPORT int vp_command(void) {
  g_reply[0] = '\0';
  if (!g_ready) {
    std::strcpy(g_reply, "err not initialised");
    return 0;
  }
  g_text[kTextCap - 1] = '\0';
  return g_pedal.Command(g_text, g_reply, sizeof g_reply) ? 1 : 0;
}

// Telemetry: moves the pending telemetry text (whole lines, "\r\n" endings;
// [L] [M] [S] [SYS]) to vp_lines_ptr() and returns its length in bytes (0 =
// nothing new). The text is NUL terminated and valid until the next call.
VP_EXPORT const char* vp_lines_ptr(void) { return g_lines; }
VP_EXPORT int vp_poll(void) {
  g_lines[0] = '\0';
  if (!g_ready) return 0;
  return static_cast<int>(g_pedal.TakeTelemetry(g_lines, sizeof g_lines));
}

// Hardware inputs. Knob 0..5 = K1..K6, value 0..1. Toggle 0..2 = S1..S3,
// position 0 up / 1 middle / 2 down. Footswitch 0..1 = FS1, FS2, down 0/1.
VP_EXPORT void vp_knob(int i, float value) {
  if (g_ready) g_pedal.SetKnob(i, value);
}
VP_EXPORT void vp_toggle(int i, int pos) {
  if (g_ready) g_pedal.SetToggle(i, pos);
}
VP_EXPORT void vp_footswitch(int i, int down) {
  if (g_ready) g_pedal.SetFootswitch(i, down != 0);
}

// The effect pedal in the FX loop. type 0 = TS-style overdrive (drive, tone,
// level), 1 = chorus (rate, depth, mix); on 0/1; controls 0..1.
VP_EXPORT void vp_set_loop_fx(int type, int on, float p0, float p1, float p2) {
  if (!g_ready) return;
  bm::virt::FxConfig c;
  c.type = type == 1 ? bm::virt::FxType::kChorus : bm::virt::FxType::kOverdrive;
  c.on = on != 0;
  c.p[0] = p0;
  c.p[1] = p1;
  c.p[2] = p2;
  g_pedal.SetLoopFx(c);
}
// Round trip in samples that the selected loop pedal adds (what the loop
// measurement finds): 1.0 ms or 1.8 ms.
VP_EXPORT float vp_loop_fx_latency(void) { return g_ready ? g_pedal.loop_fx_latency_samples() : 0.0f; }

// CPU load to show in [SYS] (0..1; the pedal cannot measure it itself).
VP_EXPORT void vp_set_cpu(float avg, float max) {
  if (g_ready) g_pedal.SetCpuLoad(avg, max);
}

// Taps. mask: 1 = scope, 2 = spectrum, 0 = none (nothing is computed).
VP_EXPORT void vp_taps_enable(int mask) {
  if (g_ready) g_pedal.EnableTaps(mask);
}
// Scope: returns the number of new points (up to vp_scope_stride()) since the
// last call; channel c (0 in, 1 sub, 2 up, 3 out) is at vp_scope_ptr()[c * stride + i].
// One point = the mean of 8 samples.
VP_EXPORT float* vp_scope_ptr(void) { return g_scope; }
VP_EXPORT int vp_scope_stride(void) { return kScopeStride; }
VP_EXPORT int vp_scope_pull(void) {
  return g_ready ? g_pedal.PullScope(g_scope, kScopeStride, kScopeStride) : 0;
}
// Spectrum: returns 1 when a new frame was written to vp_spectrum_ptr()
// (3 signals x vp_spectrum_bands() values in dBFS: in, low band, high band),
// else 0. vp_spectrum_hz_ptr() holds the centre frequency of each band.
VP_EXPORT float* vp_spectrum_ptr(void) { return g_spectrum; }
VP_EXPORT const float* vp_spectrum_hz_ptr(void) { return g_ready ? g_pedal.spectrum_band_hz() : nullptr; }
VP_EXPORT int vp_spectrum_bands(void) { return bm::virt::kSpecBands; }
VP_EXPORT int vp_spectrum_pull(void) { return g_ready && g_pedal.PullSpectrum(g_spectrum) ? 1 : 0; }
