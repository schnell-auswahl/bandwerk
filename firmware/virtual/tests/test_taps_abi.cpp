// Taps (scope, spectrum) and the C ABI.
#include "test_rig.h"
#include "virtual/abi.cpp"  // the ABI in this translation unit (its pedal is separate from the Rig's)

using namespace vt;

TEST(taps_cost_nothing_until_enabled) {
  Rig r;
  r.Seconds(0.5f);
  float buf[4 * 1024];
  CHECK(r.p->PullScope(buf, 1024, 1024) == 0);
  float spec[3 * 96];
  CHECK(!r.p->PullSpectrum(spec));
}

TEST(scope_tap_delivers_decimated_in_sub_up_out) {
  Rig r;
  r.Cmd("oct on");
  r.p->EnableTaps(bm::virt::kTapScope);
  r.Run(4800, [](int i) { return 0.4f * std::sin(0.0171f * static_cast<float>(i)); });  // 131 Hz, settles the octaver
  float buf[4 * 1024];
  r.p->PullScope(buf, 1024, 1024);  // discard
  auto out = r.Run(4800, [](int i) { return 0.4f * std::sin(0.0171f * static_cast<float>(i + 4800)); });
  const int n = r.p->PullScope(buf, 1024, 1024);
  CHECK(n == 4800 / bm::virt::kScopeDecim);
  float in_peak = 0.0f, out_peak = 0.0f, sub_peak = 0.0f;
  for (int i = 0; i < n; ++i) {
    in_peak = std::fmax(in_peak, std::fabs(buf[0 * 1024 + i]));
    sub_peak = std::fmax(sub_peak, std::fabs(buf[1 * 1024 + i]));
    out_peak = std::fmax(out_peak, std::fabs(buf[3 * 1024 + i]));
  }
  CHECK(in_peak > 0.3f && in_peak < 0.41f);
  CHECK(out_peak > 0.05f);
  CHECK(sub_peak > 0.01f);  // the -1 octave exists
  // the output channel is the (mean-decimated) output
  double e = 0.0;
  for (int i = 0; i < n; ++i) {
    double m = 0.0;
    for (int k = 0; k < 8; ++k) m += out[i * 8 + k];
    e = std::fmax(e, std::fabs(m / 8.0 - buf[3 * 1024 + i]));
  }
  CHECK(e < 1e-5);
  // nothing new -> nothing returned
  CHECK(r.p->PullScope(buf, 1024, 1024) == 0);
}

TEST(spectrum_tap_shows_a_sine_at_its_frequency_and_level) {
  Rig r;
  r.p->EnableTaps(bm::virt::kTapSpectrum);
  const float w = 6.2831853f * 105.46875f / 48000.0f;  // exactly on FFT bin 9, 0.5 (-6 dBFS)
  r.Run(48000, [&](int i) { return 0.5f * std::sin(w * static_cast<float>(i)); });
  float spec[3 * 96];
  CHECK(r.p->PullSpectrum(spec));
  const float* hz = r.p->spectrum_band_hz();
  int best = 0;
  for (int b = 1; b < 96; ++b)
    if (spec[b] > spec[best]) best = b;
  CHECK(std::fabs(hz[best] - 105.0f) < 10.0f);
  CHECK_NEAR(spec[best], -6.0, 0.3);
  CHECK(spec[90] < -60.0f);  // far above the tone: nothing
  CHECK(hz[0] > 20.0f && hz[0] < 21.0f && hz[95] < 20000.0f && hz[95] > 18000.0f);
  // the low band (below the 250 Hz crossover) carries the tone
  float low_best = -200.0f;
  for (int b = 0; b < 96; ++b) low_best = std::fmax(low_best, spec[96 + b]);
  CHECK(low_best > -12.0f);
}

TEST(the_c_abi_matches_the_class) {
  CHECK(vp_abi_version() == 1);
  CHECK(vp_init(10) == 1);  // bad sample rate
  CHECK(vp_init(48000) == 0);
  std::strcpy(vp_text_ptr(), "hello");
  CHECK(vp_command() == 1);
  CHECK(std::string(vp_reply_ptr()) == "ok hello fw=0.2.0-beta proto=1 build=virtual app=wasm board=virtual");
  std::strcpy(vp_text_ptr(), "dfu");
  CHECK(vp_command() == 0);
  CHECK(std::string(vp_reply_ptr()) == "err not available in the virtual pedal");

  Rig r;
  for (int blk = 0; blk < 200; ++blk) {
    float in[128];
    for (int i = 0; i < 128; ++i) in[i] = 0.3f * std::sin(0.02f * static_cast<float>(blk * 128 + i));
    std::memcpy(vp_in_ptr(), in, sizeof in);
    vp_process(128);
    float out[128];
    r.p->Process(in, out, 128);
    CHECK(std::memcmp(out, vp_out_ptr(), sizeof out) == 0);
  }
  // telemetry text through vp_poll() equals the class's text
  std::string text;
  while (vp_poll() > 0) text += vp_lines_ptr();
  char buf[8192];
  std::string ref;
  size_t n;
  while ((n = r.p->TakeTelemetry(buf, sizeof buf)) > 0) ref += buf;
  CHECK(!text.empty() && text == ref);
  CHECK(vp_poll() == 0);

  vp_knob(0, 0.9f);
  vp_toggle(2, 2);
  vp_footswitch(0, 0);
  vp_set_loop_fx(1, 1, 0.1f, 0.2f, 0.3f);
  CHECK_NEAR(vp_loop_fx_latency(), 86.4, 1e-3);
  vp_set_loop_fx(0, 0, 0.1f, 0.2f, 0.3f);
  CHECK_NEAR(vp_loop_fx_latency(), 48.0, 1e-4);
  vp_taps_enable(3);
  CHECK(vp_spectrum_bands() == 96 && vp_scope_stride() == 1024 && vp_max_frames() == 1024);
  vp_taps_enable(0);
}

TEST(the_c_abi_ignores_bad_arguments) {
  vp_init(48000);
  vp_knob(9, 1.0f);
  vp_toggle(7, 1);
  vp_toggle(0, 5);
  vp_footswitch(5, 1);
  vp_process(-5);
  vp_process(100000);  // clamped to the buffer
  std::memset(vp_text_ptr(), 'x', 127);
  vp_text_ptr()[127] = '\0';
  CHECK(vp_command() == 0);  // unknown command, no crash
}
