// The result must not depend on how the host cuts the audio into calls (the
// worklet passes 128 frames, the tests pass anything), and the same input must
// always give the same output.
#include "test_rig.h"

using namespace vt;

namespace {

// Runs the same session on a rig, splitting each 4800-sample segment into
// calls of the sizes `chunk(k)` (k = call counter).
template <class Chunk>
void Session(Rig& r, Chunk chunk, std::vector<float>* all_out) {
  Noise noise(4242);
  int k = 0;
  for (int seg = 0; seg < 40; ++seg) {
    // the same actions at the same sample positions
    switch (seg) {
      case 2: r.Cmd("oct on"); break;
      case 4: r.p->SetToggle(1, 1); break;                 // S2 Bridge -> Loop: measures
      case 9: r.Cmd("drv on"); r.Cmd("dtype fuzz"); break;
      case 12: r.p->SetKnob(0, 0.7f); break;
      case 14: r.p->SetFootswitch(1, true); break;
      case 15: r.p->SetFootswitch(1, false); break;
      case 18: { FxConfig c; c.type = FxType::kChorus; c.on = true; r.p->SetLoopFx(c); } break;
      case 24: r.p->SetToggle(1, 0); break;
      case 26: r.p->SetToggle(1, 2); break;
      case 30: r.Cmd("byp on"); break;
      default: break;
    }
    std::vector<float> in(4800), out(4800);
    for (int i = 0; i < 4800; ++i) {
      in[i] = 0.3f * std::sin(0.0143f * static_cast<float>(seg * 4800 + i)) * (1.0f + 0.5f * std::sin(0.0007f * static_cast<float>(seg * 4800 + i))) +
              0.02f * noise.Next();
    }
    for (int i = 0; i < 4800;) {
      int n = chunk(k++);
      if (n > 4800 - i) n = 4800 - i;
      r.p->Process(in.data() + i, out.data() + i, n);
      r.Drain();
      i += n;
    }
    all_out->insert(all_out->end(), out.begin(), out.end());
  }
}

}  // namespace

TEST(the_result_does_not_depend_on_the_size_of_the_audio_calls) {
  Rig a, b, c;
  std::vector<float> oa, ob, oc;
  Session(a, [](int) { return 128; }, &oa);
  Session(b, [](int k) { return 1 + (k * 37) % 301; }, &ob);
  Session(c, [](int) { return 4; }, &oc);
  CHECK(oa.size() == ob.size());
  CHECK(std::memcmp(oa.data(), ob.data(), oa.size() * sizeof(float)) == 0);
  CHECK(std::memcmp(oa.data(), oc.data(), oa.size() * sizeof(float)) == 0);
  CHECK(a.lines == b.lines);
  CHECK(a.lines == c.lines);
  CHECK(a.lines.size() > 100);
  CHECK(AllFinite(oa));
}

TEST(init_restarts_the_pedal_like_a_power_cycle) {
  Rig a, b;
  std::vector<float> oa, ob;
  Session(a, [](int) { return 128; }, &oa);
  Session(b, [](int) { return 128; }, &ob);  // a second identical run
  CHECK(std::memcmp(oa.data(), ob.data(), oa.size() * sizeof(float)) == 0);
  // run `a` again after Init: identical to the first run
  a.p->Init(Rig::kSr);
  a.lines.clear();
  std::vector<float> oa2;
  Session(a, [](int) { return 128; }, &oa2);
  CHECK(std::memcmp(oa.data(), oa2.data(), oa.size() * sizeof(float)) == 0);
}
