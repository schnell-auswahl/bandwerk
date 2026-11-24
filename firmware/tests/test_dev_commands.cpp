#include <cstring>

#include "line_commands.h"
#include "test_framework.h"
#include "ui/dev_commands.h"

using namespace bm;

namespace {

struct Bench {
  UiController ui;
  UiInputs in;
  uint32_t now = 1000;
  Bench() {
    for (int i = 0; i < 6; ++i) in.knob[i] = 0.5f;
    in.now_ms = now;
    ui.Init(in, Params(), UiConfig());
  }
  void Run(uint32_t ms) {
    for (uint32_t i = 0; i < ms; ++i) {
      in.now_ms = ++now;
      ui.Update(in);
    }
  }
  // Sends one command, returns the reply text.
  const char* Cmd(const char* text) {
    static char reply[96];
    char line[96];
    std::snprintf(line, sizeof line, "%s", text);
    ApplyDevCommand(ui, line, reply, sizeof reply);
    return reply;
  }
};

bool Starts(const char* s, const char* prefix) { return std::strncmp(s, prefix, std::strlen(prefix)) == 0; }

}  // namespace

TEST(tokenizer_splits_in_place_and_parses_numbers) {
  char line[] = "  set   cl_dw\t1000 ";
  const devkit::Tokens t = devkit::Tokenize(line);
  CHECK(t.n == 3);
  CHECK(devkit::Is(t.t[0], "set") && devkit::Is(t.t[1], "cl_dw") && devkit::Is(t.t[2], "1000"));
  int v = 0;
  CHECK(devkit::ToInt("-42", &v) && v == -42);
  CHECK(!devkit::ToInt("4x", &v));
  CHECK(!devkit::ToInt("", &v));
  char empty[] = "   ";
  CHECK(devkit::Tokenize(empty).n == 0);
}

TEST(parameter_table_is_consistent_with_the_stored_values) {
  Params p;
  float* expected[kNumParams] = {
      &p.master, &p.crossover, &p.comp[0].threshold, &p.comp[0].ratio, &p.comp[0].release,
      &p.comp[0].dry_wet, &p.comp[1].threshold, &p.comp[1].ratio, &p.comp[1].release,
      &p.comp[1].dry_wet, &p.loop_send, &p.loop_mix, &p.loop_return, &p.loop_trim,
      &p.oct_level_down, &p.oct_dry_wet, &p.oct_level_up, &p.oct_sub_tone, &p.drive_gain,
      &p.drive_band_mix, &p.drive_level, &p.drive_tone};
  for (int i = 0; i < kNumParams; ++i) {
    CHECK(ParamPtr(p, i) == expected[i]);
    CHECK(ParamIndex(ParamName(i)) == i);  // names are unique and round-trip
  }
  CHECK(ParamPtr(p, kNumParams) == nullptr);
  CHECK(ParamIndex("nonsense") < 0);
  for (int i = 0; i < kNumParams; ++i)
    for (int j = i + 1; j < kNumParams; ++j) CHECK(std::strcmp(ParamName(i), ParamName(j)) != 0);
}

TEST(set_changes_the_stored_parameter_by_name_and_by_index) {
  Bench b;
  CHECK(Starts(b.Cmd("set cl_dw 250"), "ok set cl_dw 250"));
  CHECK_NEAR(b.ui.params().comp[1].dry_wet, 0.25, 1e-6);
  CHECK(Starts(b.Cmd("set 5 1000"), "ok set ch_dw 1000"));
  CHECK_NEAR(b.ui.params().comp[0].dry_wet, 1.0, 1e-6);
  CHECK(Starts(b.Cmd("set dv_tone 0"), "ok"));
  CHECK_NEAR(b.ui.params().drive_tone, 0.0, 1e-6);
}

TEST(set_rejects_bad_input_without_changing_anything) {
  Bench b;
  const Params before = b.ui.params();
  CHECK(Starts(b.Cmd("set nonsense 500"), "err"));
  CHECK(Starts(b.Cmd("set cl_dw 1001"), "err"));
  CHECK(Starts(b.Cmd("set cl_dw -1"), "err"));
  CHECK(Starts(b.Cmd("set cl_dw abc"), "err"));
  CHECK(Starts(b.Cmd("set cl_dw"), "err"));
  CHECK(Starts(b.Cmd("set 99 500"), "err"));
  CHECK(Starts(b.Cmd("unknown"), "err"));
  CHECK(Starts(b.Cmd(""), "err"));
  CHECK_NEAR(b.ui.params().comp[1].dry_wet, before.comp[1].dry_wet, 1e-9);
  CHECK_NEAR(b.ui.params().master, before.master, 1e-9);
}

TEST(switches_and_pages_can_be_set) {
  Bench b;
  CHECK(Starts(b.Cmd("oct on"), "ok oct on"));
  CHECK(b.ui.params().octave_on);
  CHECK(Starts(b.Cmd("drv on"), "ok"));
  CHECK(b.ui.params().drive_on);
  CHECK(Starts(b.Cmd("byp on"), "ok"));
  CHECK(b.ui.bypass());
  CHECK(Starts(b.Cmd("byp off"), "ok"));
  CHECK(!b.ui.bypass());
  CHECK(Starts(b.Cmd("oct maybe"), "err"));
  CHECK(Starts(b.Cmd("page drive"), "ok page drive"));
  CHECK(b.ui.page() == Page::kDrive);
  CHECK(Starts(b.Cmd("page comp"), "ok"));
  CHECK(b.ui.page() == Page::kComp);
  CHECK(Starts(b.Cmd("page nowhere"), "err"));
  CHECK(Starts(b.Cmd("ping"), "ok ping"));
}

TEST(remote_master_survives_until_its_knob_moves_and_crossover_is_picked_up) {
  Bench b;
  b.Run(50);
  CHECK(Starts(b.Cmd("set master 800"), "ok"));
  CHECK(Starts(b.Cmd("set xover 100"), "ok"));
  b.Run(500);  // the knobs still sit at 0.5: the remote values must stay
  CHECK_NEAR(b.ui.params().master, 0.8, 1e-6);
  CHECK_NEAR(b.ui.params().crossover, 0.1, 1e-6);
  b.in.knob[0] = 0.3f;  // moving K1 takes control back
  b.Run(50);
  CHECK_NEAR(b.ui.params().master, 0.3, 0.01);
  CHECK_NEAR(b.ui.params().crossover, 0.1, 1e-6);  // K3 untouched: still remote
  b.in.knob[2] = 0.3f;  // K3 moved but has not reached the remote value yet
  b.Run(50);
  CHECK_NEAR(b.ui.params().crossover, 0.1, 1e-6);
  b.in.knob[2] = 0.05f;  // crossed it: K3 is in control
  b.Run(50);
  b.in.knob[2] = 0.9f;
  b.Run(50);
  CHECK_NEAR(b.ui.params().crossover, 0.9, 0.01);
}

TEST(defaults_restore_the_spec_values_and_keep_them) {
  Bench b;
  b.in.knob[0] = 0.3f;  // K1 physically elsewhere: the default must not be overwritten by it
  b.Run(100);
  b.Cmd("set cl_dw 100");
  b.Cmd("set master 900");
  b.Cmd("oct on");
  CHECK(Starts(b.Cmd("defaults"), "ok defaults"));
  b.Run(300);
  const Params d;
  CHECK_NEAR(b.ui.params().comp[1].dry_wet, d.comp[1].dry_wet, 1e-6);
  CHECK_NEAR(b.ui.params().master, d.master, 1e-6);  // not overwritten by the knob
  CHECK(!b.ui.params().octave_on);
}

TEST(every_remote_change_counts_as_a_revision) {
  Bench b;
  b.Run(100);
  const uint32_t r0 = b.ui.revision();
  b.Cmd("set cl_dw 300");
  CHECK(b.ui.revision() > r0);  // the telemetry prints a fresh state line
  const uint32_t r1 = b.ui.revision();
  b.Cmd("byp on");
  CHECK(b.ui.revision() > r1);
}

TEST(defaults_hold_master_and_crossover_against_the_knob_positions) {
  Bench b;
  b.in.knob[0] = 0.3f;
  b.in.knob[2] = 0.8f;
  b.Run(200);
  CHECK_NEAR(b.ui.params().master, 0.3, 0.01);   // normal: knobs rule
  b.Cmd("defaults");
  b.Run(300);
  CHECK_NEAR(b.ui.params().master, 0.5, 1e-6);   // defaults stay although K1 sits at 0.3
  CHECK_NEAR(b.ui.params().crossover, 0.5, 1e-6);
}

TEST(drive_type_can_be_set_remotely_and_a_switch_move_takes_it_back) {
  Bench b;
  b.Run(500);
  CHECK(b.ui.drive_type() == DriveType::kDistortion);       // switches in the middle at start
  CHECK(Starts(b.Cmd("dtype fuzz"), "ok dtype fuzz"));
  CHECK(b.ui.drive_type() == DriveType::kFuzz);
  b.Run(500);                                                // nothing moved: stays
  CHECK(b.ui.drive_type() == DriveType::kFuzz);
  CHECK(Starts(b.Cmd("dtype od"), "ok"));
  CHECK(b.ui.drive_type() == DriveType::kOverdrive);
  CHECK(Starts(b.Cmd("dtype nonsense"), "err"));
  CHECK(Starts(b.Cmd("dtype"), "err"));
  b.in.toggle[2] = TogglePos::kDown;                         // S3 down = fuzz as the switch says
  b.Run(500);
  CHECK(b.ui.drive_type() == DriveType::kFuzz);
}

TEST(lmode_sets_the_loop_mode_until_a_switch_moves) {
  Bench b;
  b.Run(50);
  CHECK(Starts(b.Cmd("lmode loop"), "ok"));
  CHECK(b.ui.loop_mode() == LoopMode::kLoop);
  CHECK(Starts(b.Cmd("lmode inv"), "ok"));
  CHECK(b.ui.loop_mode() == LoopMode::kLoopInverted);
  CHECK(Starts(b.Cmd("lmode bridge"), "ok"));
  CHECK(b.ui.loop_mode() == LoopMode::kBridge);
  CHECK(Starts(b.Cmd("lmode x"), "err"));
}

TEST(band_sets_the_compressor_band_until_a_switch_moves) {
  Bench b;
  b.Run(50);
  CHECK(Starts(b.Cmd("band high"), "ok"));
  CHECK(b.ui.band() == BandSel::kHigh);
  CHECK(Starts(b.Cmd("band low"), "ok"));
  CHECK(b.ui.band() == BandSel::kLow);
  CHECK(Starts(b.Cmd("band both"), "ok"));
  CHECK(b.ui.band() == BandSel::kBoth);
  CHECK(Starts(b.Cmd("band x"), "err"));
  CHECK(Starts(b.Cmd("band"), "err"));
  b.in.toggle[0] = TogglePos::kUp;  // S1 up = high band as the switch says
  b.Run(500);
  CHECK(b.ui.band() == BandSel::kHigh);
}

TEST(band_change_makes_the_comp_knobs_pick_up_again) {
  Bench b;
  b.Run(50);
  b.Cmd("page comp");
  b.Run(50);
  for (int i = 0; i <= 100; ++i) {  // sweep K2 (ratio) through its stored value
    b.in.knob[1] = i * 0.01f;
    b.Run(5);
  }
  CHECK((b.ui.caught_mask() & 1) != 0);
  CHECK(Starts(b.Cmd("band low"), "ok"));
  CHECK((b.ui.caught_mask() & 1) == 0);  // now edits the low band: pick up again
}

TEST(hello_reports_version_build_and_layout_exactly_as_in_the_protocol) {
  Bench b;
  BuildInfo release;
  release.build = "release";
  release.app = "boot_sram";
  char line[96] = "hello";
  char reply[96];
  CHECK(ApplyDevCommand(b.ui, line, reply, sizeof reply, release));
  CHECK(std::strcmp(reply, "ok hello fw=" BM_FW_VERSION " proto=1 build=release app=boot_sram board=hothouse") == 0);
  CHECK(std::strcmp(BM_FW_VERSION, "0.2.0-beta") == 0);
  CHECK(BM_PROTO_VERSION == 1);

  BuildInfo emergency;
  emergency.build = "release";
  emergency.app = "boot_none";
  emergency.board = "funbox";
  std::snprintf(line, sizeof line, "hello studio/1");  // extra words are ignored
  CHECK(ApplyDevCommand(b.ui, line, reply, sizeof reply, emergency));
  CHECK(std::strcmp(reply, "ok hello fw=0.2.0-beta proto=1 build=release app=boot_none board=funbox") == 0);

  // Default BuildInfo = dev build in the Daisy bootloader layout.
  CHECK(std::strcmp(b.Cmd("hello"), "ok hello fw=0.2.0-beta proto=1 build=dev app=boot_sram board=hothouse") == 0);
}

TEST(hello_changes_nothing) {
  Bench b;
  b.Run(50);
  const uint32_t r0 = b.ui.revision();
  b.Cmd("hello");
  CHECK(b.ui.revision() == r0);
}

TEST(dfu_replies_first_and_asks_the_firmware_for_the_bootloader) {
  Bench b;
  char line[96] = "dfu";
  char reply[96];
  RemoteAction action = RemoteAction::kNone;
  CHECK(ApplyDevCommand(b.ui, line, reply, sizeof reply, BuildInfo(), &action));
  CHECK(std::strcmp(reply, "ok dfu") == 0);
  CHECK(action == RemoteAction::kEnterBootloader);

  std::snprintf(line, sizeof line, "dfu now");
  CHECK(!ApplyDevCommand(b.ui, line, reply, sizeof reply, BuildInfo(), &action));
  CHECK(Starts(reply, "err"));
  CHECK(action == RemoteAction::kNone);
}

TEST(only_dfu_requests_an_action) {
  Bench b;
  const char* cmds[] = {"ping", "hello", "set 0 500", "oct on", "byp off", "page loop", "dtype od",
                        "lmode bridge", "band both", "defaults", "reboot", "save", "wipe",
                        "looptest", "nonsense", ""};
  for (const char* c : cmds) {
    char line[96];
    char reply[96];
    std::snprintf(line, sizeof line, "%s", c);
    RemoteAction action = RemoteAction::kEnterBootloader;
    ApplyDevCommand(b.ui, line, reply, sizeof reply, BuildInfo(), &action);
    CHECK(action == RemoteAction::kNone);
  }
}

TEST(dev_only_commands_are_unknown_to_the_shared_module) {
  // reboot/save/wipe/looptest are handled by the dev firmware before this module;
  // a release build therefore answers them with an error.
  Bench b;
  CHECK(std::strcmp(b.Cmd("reboot"), "err unknown command") == 0);
  CHECK(std::strcmp(b.Cmd("save"), "err unknown command") == 0);
  CHECK(std::strcmp(b.Cmd("wipe"), "err unknown command") == 0);
  CHECK(std::strcmp(b.Cmd("looptest"), "err unknown command") == 0);
}
