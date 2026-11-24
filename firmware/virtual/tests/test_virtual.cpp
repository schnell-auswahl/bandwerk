// The virtual pedal: commands, telemetry schedule, hardware gestures, loop
// measurement through the virtual effect pedals, taps.
#include "test_rig.h"

using namespace vt;

TEST(hello_identifies_the_virtual_pedal) {
  Rig r;
  CHECK(r.Cmd("hello") == "ok hello fw=0.2.0-beta proto=1 build=virtual app=wasm board=virtual");
  CHECK(r.Cmd("hello from-the-web 1.2") == "ok hello fw=0.2.0-beta proto=1 build=virtual app=wasm board=virtual");
  CHECK(r.Cmd("ping") == "ok ping");
}

TEST(commands_that_need_hardware_are_refused) {
  Rig r;
  for (const char* c : {"dfu", "reboot", "save", "wipe", "looptest", "looptest now"}) {
    CHECK(r.Cmd(c) == "err not available in the virtual pedal");
  }
  CHECK(r.Cmd("frobnicate") == "err unknown command");
  CHECK(r.Cmd("") == "err empty");
}

TEST(the_normal_commands_answer_like_the_firmware) {
  Rig r;
  CHECK(r.Cmd("set master 700") == "ok set master 700");
  CHECK(r.Cmd("set 11 250") == "ok set lp_mix 250");
  CHECK(r.Cmd("set master 1001") == "err value must be 0..1000");
  CHECK(r.Cmd("set nope 1") == "err unknown parameter");
  CHECK(r.Cmd("set 22 1") == "err parameter index out of range");
  CHECK(r.Cmd("oct on") == "ok oct on");
  CHECK(r.Cmd("drv 1") == "ok drv on");
  CHECK(r.Cmd("byp maybe") == "err usage: oct|drv|byp on|off");
  CHECK(r.Cmd("dtype fuzz") == "ok dtype fuzz");
  CHECK(r.Cmd("lmode inv") == "ok lmode inv");
  CHECK(r.Cmd("band low") == "ok band low");
  CHECK(r.Cmd("page oct") == "ok page oct");
  CHECK(r.Cmd("defaults") == "ok defaults");
}

TEST(a_long_command_line_is_cut_like_the_usb_link_does) {
  Rig r;
  std::string longline = "ping " + std::string(200, 'x');
  CHECK(r.Cmd(longline.c_str()) == "ok ping");
}

TEST(telemetry_follows_the_firmware_schedule) {
  Rig r;
  r.Seconds(2.1f);
  // [L] and [M] come together at 20 Hz
  CHECK(r.Count("[L]") >= 41 && r.Count("[L]") <= 42);
  CHECK(r.Count("[M]") == r.Count("[L]"));
  // [S] once at start (changed state) and with every [SYS]
  CHECK(r.Count("[SYS]") == 2);
  CHECK(r.Count("[S]") >= 2 && r.Count("[S]") <= 4);
  const std::string sys = r.Last("[SYS]");
  CHECK(Field(sys, "sr") == 48000);
  CHECK(Field(sys, "block") == 4);
  CHECK(Field(sys, "loops") >= 995 && Field(sys, "loops") <= 1005);
  CHECK(Field(sys, "lat") == 0);
  CHECK(Field(sys, "lres") == -1);
  const std::string s = r.Last("[S]");
  CHECK(s.find("[S] pg=3 bd=1 lm=0 dt=1 oc=0 dr=0 by=0") == 0);
  CHECK(s.find("pm=500,500,647,414,463,600,471,431,528,1000,500,1000,500,500,500,500,500,500,500,500,500,500") != std::string::npos);
}

TEST(a_state_change_is_reported_within_100_ms) {
  Rig r;
  r.Seconds(1.2f);
  r.lines.clear();
  r.Cmd("oct on");
  r.Seconds(0.15f);
  CHECK(r.Last("[S]").find(" oc=1 ") != std::string::npos);
}

TEST(footswitch_gestures_work_through_the_virtual_hardware) {
  Rig r;
  r.Seconds(0.2f);
  r.p->SetFootswitch(0, true);
  r.Seconds(0.1f);
  r.p->SetFootswitch(0, false);
  r.Seconds(0.3f);
  CHECK(r.p->ui().params().octave_on);
  CHECK(r.p->ui().page() == bm::Page::kOctave);
  // FS2 tap switches the drive on; both together toggle the bypass
  r.p->SetFootswitch(1, true);
  r.Seconds(0.1f);
  r.p->SetFootswitch(1, false);
  r.Seconds(0.2f);
  CHECK(r.p->ui().params().drive_on);
  r.p->SetFootswitch(0, true);
  r.p->SetFootswitch(1, true);
  r.Seconds(0.1f);
  r.p->SetFootswitch(0, false);
  r.p->SetFootswitch(1, false);
  r.Seconds(0.2f);
  CHECK(r.p->ui().bypass());
  // the LED values and footswitch states are in the live frame
  r.Seconds(0.2f);
  CHECK(r.Last("[S]").find(" by=1 ") != std::string::npos);
}

TEST(toggles_change_the_page_at_once_and_the_setting_after_settling) {
  Rig r;
  r.Seconds(0.2f);
  r.p->SetToggle(0, 0);  // S1 up: page COMP, band HIGH
  r.Seconds(0.05f);
  CHECK(r.p->ui().page() == bm::Page::kComp);
  CHECK(r.p->ui().band() == bm::BandSel::kBoth);  // not settled yet
  r.Seconds(0.4f);
  CHECK(r.p->ui().band() == bm::BandSel::kHigh);
  r.p->SetToggle(2, 2);  // S3 down: page DRIVE, fuzz
  r.Seconds(0.5f);
  CHECK(r.p->ui().drive_type() == bm::DriveType::kFuzz);
}

TEST(knobs_use_soft_takeover_and_the_global_ones_act_at_once) {
  Rig r;
  r.Seconds(0.2f);
  r.p->SetKnob(0, 0.8f);  // master follows its knob at once
  r.Seconds(0.1f);
  CHECK_NEAR(r.p->ui().params().master, 0.8f, 0.01f);
  // A remote value on page DRIVE: K2 (at 12 o'clock) has to pick it up first.
  r.Cmd("set dv_gain 800");
  r.p->SetKnob(1, 0.45f);
  r.Seconds(0.1f);
  CHECK_NEAR(r.p->ui().params().drive_gain, 0.8f, 1e-6);
  r.p->SetKnob(1, 0.8f);
  r.Seconds(0.1f);
  r.p->SetKnob(1, 0.95f);
  r.Seconds(0.1f);
  CHECK_NEAR(r.p->ui().params().drive_gain, 0.95f, 0.01f);
}

TEST(bypass_passes_the_input_through) {
  Rig r;
  r.Seconds(0.1f);
  r.Cmd("byp on");
  auto in = [](int i) { return 0.3f * std::sin(0.0143f * static_cast<float>(i)); };
  auto out = r.Run(9600, in);
  double err = 0.0;
  for (int i = 4800; i < 9600; ++i) err = std::fmax(err, std::fabs(out[i] - in(i)));
  CHECK(err < 1e-5);  // the bypass smoother stops about 4e-6 short of 1.0 (as on the pedal)
}

TEST(the_audio_stays_finite_and_bounded_under_random_commands) {
  Rig r;
  Noise rnd(99);
  const char* kinds[] = {"oct", "drv", "byp"};
  std::vector<float> all;
  for (int step = 0; step < 300; ++step) {
    char cmd[64];
    const int k = static_cast<int>((rnd.Next() * 0.5f + 0.5f) * 5.99f);
    if (k < 3) {
      std::snprintf(cmd, sizeof cmd, "%s %s", kinds[k], rnd.Next() > 0 ? "on" : "off");
    } else if (k == 3) {
      std::snprintf(cmd, sizeof cmd, "set %d %d", static_cast<int>((rnd.Next() * 0.5f + 0.5f) * 21.99f),
                    static_cast<int>((rnd.Next() * 0.5f + 0.5f) * 1000.0f));
    } else if (k == 4) {
      std::snprintf(cmd, sizeof cmd, "lmode %s", rnd.Next() > 0 ? "loop" : "inv");
    } else {
      std::snprintf(cmd, sizeof cmd, "dtype %s", rnd.Next() > 0.3f ? "fuzz" : "od");
    }
    r.Cmd(cmd);
    if (step % 50 == 25) {
      FxConfig c;
      c.type = rnd.Next() > 0 ? FxType::kChorus : FxType::kOverdrive;
      c.on = rnd.Next() > 0;
      for (float& v : c.p) v = rnd.Next() * 0.5f + 0.5f;
      r.p->SetLoopFx(c);
    }
    Noise bass(step);
    auto out = r.Run(2400, [&](int i) {
      return 0.4f * std::sin(0.0171f * static_cast<float>(i + step * 2400)) + 0.05f * bass.Next();
    });
    CHECK(AllFinite(out));
    for (float x : out) CHECK(std::fabs(x) < 4.0f);
  }
}
