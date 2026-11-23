// The telemetry text must not change by accident: the web studio parses it
// (docs/PROTOCOL.md). The expected strings below were produced by the
// pre-refactor formatting code in bass_multiband.cpp (BM_STATE_FMT etc.) for
// exactly this state; telemetry.h has to reproduce them byte for byte.
#include <cstring>
#include <string>

#include "test_framework.h"
#include "ui/telemetry.h"

namespace {

using namespace bm;
using namespace bm::telemetry;

struct Fixture {
  UiController ui;
  UiInputs in;
  ChainMeters m;
  float raw[6];

  Fixture() {
    const float kn[6] = {0.25f, 0.5f, 0.75f, 0.125f, 0.875f, 0.4f};
    for (int i = 0; i < 6; ++i) {
      in.knob[i] = kn[i];
      raw[i] = kn[i] * 0.969f;
    }
    in.toggle[0] = TogglePos::kMiddle;
    in.toggle[1] = TogglePos::kMiddle;
    in.toggle[2] = TogglePos::kDown;
    in.now_ms = 10000;
    Params st;
    st.loop_latency = 48.0f;
    st.octave_on = true;
    st.master = 0.6f;
    st.loop_mix = 0.75f;
    st.crossover = 0.35f;
    UiConfig cfg;
    cfg.start_page = Page::kLoop;
    cfg.restore_crossover = true;
    ui.Init(in, st, cfg);
    for (int k = 0; k < 60; ++k) {
      in.now_ms += 1;
      ui.Update(in);
    }
    m.in = 0.5f; m.out = 0.25f; m.low = 0.1f; m.high = 0.05f;
    m.gr_high = 2.4f; m.gr_low = 3.6f; m.pitch_hz = 82.4f;
    m.comp_high = 0.04f; m.comp_low = 0.07f; m.send = 0.0f; m.ret = 0.0f;
    m.loop_out = 0.03f; m.low_delayed = 0.07f; m.oct_up = 0.0f; m.oct_down = 0.02f;
    m.sum_high = 0.03f; m.sum_low = 0.08f; m.fuzz_feed = 0.0f; m.drive_out = 0.03f;
    m.low_out = 0.08f; m.pre_clip = 0.3f; m.processed = 0.25f; m.gate = true;
    m.loop_delay = 48.0f;
  }
};

const char kLive[] =
    "[L] in=-60 out=-120 lo=-200 hi=-260 kn=250,500,750,125,875,400 sw=1,1,2 fs=0,0 ld=1000,2 gr=24,36 kr=242,485,727,121,848,388 pf=824\r\n"
    "[M] ch=-279 cl=-230 sd=-1200 rt=-1200 lp=-304 ll=-230 up=-1200 sb=-339 sh=-304 sl=-219 ff=-1200 do=-304 lw=-219 pc=-104 pr=-120 og=1 dl=4800 el=1\r\n";
const char kUi[] =
    "[UI] page=LOOP band=BOTH loop=LOOP drive=FUZZ oct=1 drv=0 byp=0\r\n"
    "[UI] catch=1000 M=250 X=350 send=500 mix=750 return=500 trim=500\r\n";
const char kState[] =
    "[S] pg=1 bd=1 lm=1 dt=2 oc=1 dr=0 by=0 ca=1 tp=0 pm=250,350,647,414,463,600,471,431,528,1000,500,750,500,500,500,500,500,500,500,500,500,500\r\n";
const char kSys[] = "[SYS] sr=48000 block=4 cpu avg=31.2% max=36.0% loops=640 lat=4800 ltry=3 lres=1\r\n";
const char kRaw[] = "[RAW] in L=-23 R=-100 dBFS | K 250 500 750 125 875 400 | S 1 1 2 | F 0 0\r\n";

SysInfo Sys() {
  SysInfo s;
  s.cpu_avg = 0.312f;
  s.cpu_max = 0.36f;
  s.loops = 640;
  s.loop_latency = 48.0f;
  s.loop_tries = 3;
  s.loop_result = 1;
  return s;
}

}  // namespace

TEST(telemetry_live_frame_is_pinned) {
  Fixture f;
  char buf[kBufferSize];
  Out o(buf, sizeof buf);
  AppendLive(o, f.in, f.ui, f.m, f.raw, 1);
  CHECK(std::string(o.c_str()) == kLive);
  CHECK(o.size() == std::strlen(kLive));
}

TEST(telemetry_state_line_is_pinned) {
  Fixture f;
  char buf[kBufferSize];
  Out o(buf, sizeof buf);
  AppendState(o, f.ui);
  CHECK(std::string(o.c_str()) == kState);
}

TEST(telemetry_sys_line_is_pinned) {
  char buf[kBufferSize];
  Out o(buf, sizeof buf);
  AppendSys(o, Sys());
  CHECK(std::string(o.c_str()) == kSys);
}

TEST(telemetry_dev_lines_are_pinned) {
  Fixture f;
  char buf[kBufferSize];
  Out ui(buf, sizeof buf);
  AppendUiLines(ui, f.ui);
  CHECK(std::string(ui.c_str()) == kUi);
  char buf2[kBufferSize];
  Out raw(buf2, sizeof buf2);
  AppendRaw(raw, -23, PeakDb(0.0f), f.in);
  CHECK(std::string(raw.c_str()) == kRaw);
}

TEST(telemetry_messages_compose_like_the_firmware) {
  // The firmware sends [SYS] [RAW] [S] and [UI] [UI] [S] as one message each.
  Fixture f;
  char buf[kBufferSize];
  Out o(buf, sizeof buf);
  AppendSys(o, Sys());
  AppendRaw(o, -23, -100, f.in);
  AppendState(o, f.ui);
  CHECK(std::string(o.c_str()) == std::string(kSys) + kRaw + kState);
  CHECK(o.size() < kBufferSize / 2);  // room to spare in the real buffer
}

TEST(telemetry_levels_and_permille_scaling) {
  CHECK(DbX10(1.0f) == 0);
  CHECK(DbX10(0.5f) == -60);
  CHECK(DbX10(0.0f) == -1200);
  CHECK(DbX10(1.0e-7f) == -1200);
  CHECK(Permille(0.0f) == 0);
  CHECK(Permille(0.4996f) == 500);
  CHECK(Permille(1.0f) == 1000);
  CHECK(PeakDb(0.1f) == -20);
  CHECK(PeakDb(0.0f) == -100);
}

TEST(telemetry_out_clips_and_stays_terminated) {
  char small[16];
  Out o(small, sizeof small);
  o.Add("0123456789");
  o.Add("abcdefghij");  // does not fit: clipped
  o.Add("more");        // buffer full: ignored
  CHECK(o.size() == 15);
  CHECK(std::strcmp(small, "0123456789abcde") == 0);
  char one[1];
  Out z(one, sizeof one);
  z.Add("x");
  CHECK(z.size() == 0 && one[0] == '\0');
}
