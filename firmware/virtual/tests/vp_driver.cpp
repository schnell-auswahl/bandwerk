// Native test driver for the parity test (site/tests/virtual-parity.test.mjs):
// runs a scenario against the C ABI of the virtual pedal, so that the very same
// scenario can be run against the WebAssembly build and the results compared.
//
//   vp_driver <sample_rate> <input.f32> <scenario.txt> <out.f32> <out.log>
//
// The input file holds raw little-endian float32 mono samples. Scenario lines
// (one per line, # starts a comment):
//   process <frames>          run that many frames of the input; output appended to out.f32
//   cmd <command line>        send a command; logs "CMD <line> => <ok|err> <reply>"
//   knob <i> <v>   toggle <i> <pos>   fs <i> <down>
//   loopfx <type> <on> <p0> <p1> <p2>
//   cpu <avg> <max>
//   taps <mask>
//   poll                      logs every telemetry line as "TEL <line>"
//   scope                     logs "SCOPE <n>" and the points of the 4 channels
//   spectrum                  logs "SPEC <0|1>" and, for a new frame, the 3 x 96 values
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

extern "C" {
int vp_init(int sample_rate);
int vp_max_frames(void);
float* vp_in_ptr(void);
float* vp_out_ptr(void);
void vp_process(int n);
char* vp_text_ptr(void);
const char* vp_reply_ptr(void);
int vp_command(void);
const char* vp_lines_ptr(void);
int vp_poll(void);
void vp_knob(int i, float value);
void vp_toggle(int i, int pos);
void vp_footswitch(int i, int down);
void vp_set_loop_fx(int type, int on, float p0, float p1, float p2);
void vp_set_cpu(float avg, float max);
void vp_taps_enable(int mask);
float* vp_scope_ptr(void);
int vp_scope_stride(void);
int vp_scope_pull(void);
float* vp_spectrum_ptr(void);
int vp_spectrum_bands(void);
int vp_spectrum_pull(void);
}

int main(int argc, char** argv) {
  if (argc != 6) {
    std::fprintf(stderr, "usage: vp_driver <sample_rate> <input.f32> <scenario.txt> <out.f32> <out.log>\n");
    return 2;
  }
  if (vp_init(std::atoi(argv[1])) != 0) return 2;
  std::vector<float> input;
  {
    FILE* f = std::fopen(argv[2], "rb");
    if (!f) return 2;
    float buf[4096];
    size_t n;
    while ((n = std::fread(buf, sizeof(float), 4096, f)) > 0) input.insert(input.end(), buf, buf + n);
    std::fclose(f);
  }
  FILE* sc = std::fopen(argv[3], "r");
  FILE* fo = std::fopen(argv[4], "wb");
  FILE* fl = std::fopen(argv[5], "w");
  if (!sc || !fo || !fl) return 2;

  size_t pos = 0;
  char line[512];
  while (std::fgets(line, sizeof line, sc)) {
    std::string s(line);
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
    if (s.empty() || s[0] == '#') continue;
    const size_t sp = s.find(' ');
    const std::string cmd = s.substr(0, sp);
    const std::string rest = sp == std::string::npos ? "" : s.substr(sp + 1);
    if (cmd == "process") {
      int n = std::atoi(rest.c_str());
      while (n > 0) {
        int chunk = n < vp_max_frames() ? n : vp_max_frames();
        for (int i = 0; i < chunk; ++i) vp_in_ptr()[i] = pos + i < input.size() ? input[pos + i] : 0.0f;
        vp_process(chunk);
        std::fwrite(vp_out_ptr(), sizeof(float), chunk, fo);
        pos += chunk;
        n -= chunk;
      }
    } else if (cmd == "cmd") {
      std::strncpy(vp_text_ptr(), rest.c_str(), 127);
      vp_text_ptr()[127] = '\0';
      const int ok = vp_command();
      std::fprintf(fl, "CMD %s => %s %s\n", rest.c_str(), ok ? "ok" : "err", vp_reply_ptr());
    } else if (cmd == "knob") {
      int i; float v;
      std::sscanf(rest.c_str(), "%d %f", &i, &v);
      vp_knob(i, v);
    } else if (cmd == "toggle") {
      int i, p;
      std::sscanf(rest.c_str(), "%d %d", &i, &p);
      vp_toggle(i, p);
    } else if (cmd == "fs") {
      int i, d;
      std::sscanf(rest.c_str(), "%d %d", &i, &d);
      vp_footswitch(i, d);
    } else if (cmd == "loopfx") {
      int t, on; float a, b, c;
      std::sscanf(rest.c_str(), "%d %d %f %f %f", &t, &on, &a, &b, &c);
      vp_set_loop_fx(t, on, a, b, c);
    } else if (cmd == "cpu") {
      float a, m;
      std::sscanf(rest.c_str(), "%f %f", &a, &m);
      vp_set_cpu(a, m);
    } else if (cmd == "taps") {
      vp_taps_enable(std::atoi(rest.c_str()));
    } else if (cmd == "poll") {
      const int n = vp_poll();
      const char* p = vp_lines_ptr();
      const char* end = p + n;
      while (p < end) {
        const char* nl = std::strstr(p, "\r\n");
        if (!nl) break;
        std::fprintf(fl, "TEL %.*s\n", static_cast<int>(nl - p), p);
        p = nl + 2;
      }
    } else if (cmd == "scope") {
      const int n = vp_scope_pull();
      std::fprintf(fl, "SCOPE %d\n", n);
      for (int c = 0; c < 4; ++c) {
        for (int i = 0; i < n; ++i) std::fprintf(fl, "%.9g ", vp_scope_ptr()[c * vp_scope_stride() + i]);
        std::fprintf(fl, "\n");
      }
    } else if (cmd == "spectrum") {
      const int got = vp_spectrum_pull();
      std::fprintf(fl, "SPEC %d\n", got);
      if (got) {
        for (int i = 0; i < 3 * vp_spectrum_bands(); ++i) std::fprintf(fl, "%.9g ", vp_spectrum_ptr()[i]);
        std::fprintf(fl, "\n");
      }
    } else {
      std::fprintf(stderr, "unknown scenario line: %s\n", s.c_str());
      return 2;
    }
  }
  std::fclose(fo);
  std::fclose(fl);
  std::fclose(sc);
  return 0;
}
