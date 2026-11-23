# Host-side unit tests of the virtual pedal (plain g++, no Emscripten).
# Usage: make -C firmware/virtual/tests run   (or `make -C firmware/virtual unit`)
DEVKIT_TESTS = ../../../devkit/cpp_tests
INCLUDES = -I../.. -I. -I../../../devkit/firmware
CXXFLAGS = -std=c++17 -O2 -Wall -Wextra -Werror -ffp-contract=off -DBM_CHAIN_TAPS
include $(DEVKIT_TESTS)/Makefile.inc
