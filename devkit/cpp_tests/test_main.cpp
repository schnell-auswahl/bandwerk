#include "test_framework.h"

int main() {
  for (int i = 0; i < testfw::RegistryCount(); ++i) {
    const int before = testfw::Failures();
    testfw::Registry()[i].fn();
    std::printf("[%s] %s\n", testfw::Failures() == before ? " ok " : "FAIL",
                testfw::Registry()[i].name);
  }
  std::printf("\n%d checks, %d failures\n", testfw::Checks(),
              testfw::Failures());
  return testfw::Failures() == 0 ? 0 : 1;
}
