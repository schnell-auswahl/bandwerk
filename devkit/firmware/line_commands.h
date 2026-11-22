// Tiny helpers for text commands received from the host. Hardware-free.
// A command is one line: `word arg arg ...`. Split it with Tokenize() and
// dispatch on the first word in your project's own handler.
#pragma once

#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace devkit {

constexpr int kMaxTokens = 6;

struct Tokens {
  char* t[kMaxTokens] = {nullptr, nullptr, nullptr, nullptr, nullptr, nullptr};
  int n = 0;
};

// Splits `line` in place at blanks and tabs (the line is modified).
inline Tokens Tokenize(char* line) {
  Tokens out;
  char* p = line;
  while (*p != '\0' && out.n < kMaxTokens) {
    while (*p == ' ' || *p == '\t') *p++ = '\0';
    if (*p == '\0') break;
    out.t[out.n++] = p;
    while (*p != '\0' && *p != ' ' && *p != '\t') ++p;
  }
  // terminate the last token and drop anything beyond kMaxTokens
  if (*p != '\0') *p = '\0';
  return out;
}

inline bool Is(const char* a, const char* b) { return std::strcmp(a, b) == 0; }

// Parses a complete decimal integer (optional sign). False on junk.
inline bool ToInt(const char* s, int* value) {
  if (s == nullptr || *s == '\0') return false;
  char* end = nullptr;
  const long v = std::strtol(s, &end, 10);
  if (*end != '\0') return false;
  *value = static_cast<int>(v);
  return true;
}

// Writes "ok ..." / "err ..." replies into a fixed buffer.
inline void Reply(char* reply, size_t cap, const char* status, const char* text) {
  std::snprintf(reply, cap, "%s %s", status, text);
}

}  // namespace devkit
