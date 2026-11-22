# Host-side unit tests for hardware-free code. Plain g++, no libDaisy.
#
# In your project's tests/Makefile:
#
#   DEVKIT_TESTS = ../../devkit/cpp_tests      # adjust the path
#   INCLUDES     = -I.. -I. -I../../devkit/firmware
#   include $(DEVKIT_TESTS)/Makefile.inc
#
# Put tests in tests/test_*.cpp (use TEST(name) { CHECK(...); }), then `make run`.
# The test binary is always rebuilt: make 3.81 (macOS) only compares mtimes with
# 1 s resolution and would miss quick edits.
CXX ?= g++
CXXFLAGS ?= -std=c++17 -O1 -Wall -Wextra -Werror
DEVKIT_TESTS ?= .
TEST_SRCS := $(sort $(wildcard test_*.cpp)) $(DEVKIT_TESTS)/test_main.cpp

build/run_tests: $(TEST_SRCS)
	@mkdir -p build
	$(CXX) $(CXXFLAGS) $(INCLUDES) -I$(DEVKIT_TESTS) $(TEST_SRCS) -o $@

.PHONY: run clean build/run_tests
run: build/run_tests
	./build/run_tests

clean:
	rm -rf build
