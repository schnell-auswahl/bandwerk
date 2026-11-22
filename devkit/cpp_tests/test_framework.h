// Minimal unit test helpers: no external dependencies.
#pragma once

#include <cmath>
#include <cstdio>

namespace testfw {
inline int& Failures() {
  static int n = 0;
  return n;
}
inline int& Checks() {
  static int n = 0;
  return n;
}

// Each test file defines tests with TEST(name) and they are run by main.
using TestFn = void (*)();
struct TestEntry {
  const char* name;
  TestFn fn;
};
inline TestEntry* Registry() {
  static TestEntry entries[256];
  return entries;
}
inline int& RegistryCount() {
  static int n = 0;
  return n;
}
struct Registrar {
  Registrar(const char* name, TestFn fn) {
    Registry()[RegistryCount()++] = {name, fn};
  }
};
}  // namespace testfw

#define CHECK(cond)                                                      \
  do {                                                                   \
    ++testfw::Checks();                                                  \
    if (!(cond)) {                                                       \
      ++testfw::Failures();                                              \
      std::printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);      \
    }                                                                    \
  } while (0)

#define CHECK_NEAR(a, b, tol)                                            \
  do {                                                                   \
    ++testfw::Checks();                                                  \
    const double va_ = (a), vb_ = (b);                                   \
    if (!(std::fabs(va_ - vb_) <= (tol))) {                              \
      ++testfw::Failures();                                              \
      std::printf("  FAIL %s:%d: %s ~ %s (%g vs %g, tol %g)\n",          \
                  __FILE__, __LINE__, #a, #b, va_, vb_, (double)(tol));  \
    }                                                                    \
  } while (0)

#define TEST(name)                                         \
  static void name();                                      \
  static testfw::Registrar registrar_##name(#name, name);  \
  static void name()
