// Helpers for the virtual pedal tests: a rig that feeds signals and collects
// telemetry, and a few signal generators.
#pragma once

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "test_framework.h"
#include "virtual/virtual_pedal.h"

namespace vt {

using bm::virt::FxConfig;
using bm::virt::FxType;
using bm::virt::VirtualPedal;

// Deterministic noise in -1..1.
class Noise {
 public:
  explicit Noise(uint32_t seed = 12345u) : s_(seed) {}
  float Next() {
    s_ = s_ * 1664525u + 1013904223u;
    return (static_cast<float>(s_ >> 8) / 8388608.0f) - 1.0f;
  }

 private:
  uint32_t s_;
};

struct Rig {
  static constexpr int kSr = 48000;
  // The pedal is big (tens of KB of buffers): keep it off the stack.
  std::vector<char> storage = std::vector<char>(sizeof(VirtualPedal) + 64);
  VirtualPedal* p;
  std::vector<std::string> lines;  // telemetry, one entry per line, without \r\n

  Rig() {
    void* mem = storage.data();
    p = new (mem) VirtualPedal();
    p->Init(kSr);
  }
  ~Rig() { p->~VirtualPedal(); }

  // Runs n samples of the signal x(i) (i counts from the start of this call).
  template <class F>
  std::vector<float> Run(int n, F signal) {
    std::vector<float> in(n), out(n);
    for (int i = 0; i < n; ++i) in[i] = signal(i);
    for (int i = 0; i < n; i += 128) {
      p->Process(in.data() + i, out.data() + i, n - i < 128 ? n - i : 128);
      Drain();  // like the worklet, once per 128 frames
    }
    return out;
  }
  std::vector<float> Silence(int n) {
    return Run(n, [](int) { return 0.0f; });
  }
  std::vector<float> Seconds(float s) { return Silence(static_cast<int>(s * kSr)); }

  void Drain() {
    char buf[8192];
    for (;;) {
      const size_t n = p->TakeTelemetry(buf, sizeof buf);
      if (n == 0) break;
      const char* a = buf;
      const char* end = buf + n;
      while (a < end) {
        const char* nl = std::strstr(a, "\r\n");
        if (!nl) break;
        lines.emplace_back(a, nl);
        a = nl + 2;
      }
    }
  }

  std::string Cmd(const char* line) {
    char reply[96];
    p->Command(line, reply, sizeof reply);
    return reply;
  }

  // Last telemetry line with the given tag ("[S]", "[SYS]", ...), or "".
  std::string Last(const char* tag) const {
    for (size_t i = lines.size(); i-- > 0;)
      if (lines[i].rfind(tag, 0) == 0) return lines[i];
    return "";
  }
  int Count(const char* tag) const {
    int n = 0;
    for (const auto& l : lines)
      if (l.rfind(tag, 0) == 0) ++n;
    return n;
  }
};

// Integer value of key=value in a telemetry line, or `fallback`.
inline int Field(const std::string& line, const char* key, int fallback = -99999) {
  const std::string k = std::string(" ") + key + "=";
  const size_t at = line.find(k);
  if (at == std::string::npos) return fallback;
  return std::atoi(line.c_str() + at + k.size());
}

inline double Rms(const std::vector<float>& v, size_t from, size_t to) {
  double s = 0.0;
  for (size_t i = from; i < to && i < v.size(); ++i) s += static_cast<double>(v[i]) * v[i];
  return std::sqrt(s / static_cast<double>(to - from));
}

inline bool AllFinite(const std::vector<float>& v) {
  for (float x : v)
    if (!std::isfinite(x)) return false;
  return true;
}

// Waits (in 10 ms steps) until an automatic loop measurement that started
// after S2 left Bridge has finished well. Returns the lag the pedal stored
// (samples x100), or -1 when it did not happen in time.
inline int WaitForLoopResult(Rig& r, float max_seconds = 4.0f) {
  const int steps = static_cast<int>(max_seconds * 100);
  for (int i = 0; i < steps; ++i) {
    r.Silence(480);
    const auto& c = r.p->loop_calibrator();
    if (c.tries() >= 1 && !c.measuring() && !c.pending() && c.last_result() == 1) {
      return static_cast<int>(r.p->ui().params().loop_latency * 100.0f + 0.5f);
    }
  }
  return -1;
}

// Puts S2 to Bridge (up) and then to Loop (middle), which makes the pedal
// measure its FX loop again.
inline void ReMeasure(Rig& r, int s2_pos = 1) {
  r.p->SetToggle(1, 0);
  r.Seconds(0.4f);
  r.p->SetToggle(1, s2_pos);
}

}  // namespace vt
