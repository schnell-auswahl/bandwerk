# Project Name
TARGET = bass_multiband

# Uncomment to use LGPL (like ReverbSc, etc.)
#USE_DAISYSP_LGPL=1

# Dev build (default): enables the USB serial link (telemetry, remote commands) and CPU load output.
# Release build for users: `make release` (BM_DEV=0, APP_TYPE=BOOT_NONE, see below).
BM_DEV ?= 1
ifeq ($(BM_DEV),1)
C_DEFS += -DBM_DEV
endif

# Diagnostic build: ignore the inputs and output test tones instead
# (1 kHz on OUT L, 500 Hz on OUT R, -20 dBFS). Used to verify the output wiring.
BM_DIAG_TONE ?= 0
ifeq ($(BM_DIAG_TONE),1)
C_DEFS += -DBM_DIAG_TONE
endif

# Where the program lives (libDaisy core/Makefile understands these):
#   BOOT_SRAM (default): the Daisy bootloader copies the program from the QSPI chip into
#                        the fast RAM at power-up. Up to ~480 KB, QSPI stays free for saving.
#   BOOT_QSPI:           runs in place from the QSPI chip (not used: the chip cannot be written
#                        while code runs from it, and the settings are saved there).
#   BOOT_NONE:           internal flash only, 128 KB, no bootloader. This is the release layout:
#                        one step through the STM32 ROM DFU, no bootloader needed.
# Pick one with `make APP_TYPE=BOOT_NONE ...`; always `make clean` when you switch.
# `make program-boot` installs the Daisy bootloader once (BOOT_SRAM only),
# `make program-dfu` flashes the program.
APP_TYPE ?= BOOT_SRAM

# Hothouse hardware wrapper, libDaisy and DaisySP come from the lib/HothouseExamples
# submodule (pinned; `git submodule update --init --recursive` fetches them).
HOTHOUSE_DIR = ../lib/HothouseExamples

# Sources and Hothouse header files
CPP_SOURCES = bass_multiband.cpp $(HOTHOUSE_DIR)/src/hothouse.cpp
C_INCLUDES = -I$(HOTHOUSE_DIR)/src -I. -I../devkit/firmware

# Library Locations
LIBDAISY_DIR = $(HOTHOUSE_DIR)/libDaisy
DAISYSP_DIR = $(HOTHOUSE_DIR)/DaisySP

# Core location, and generic Makefile.
SYSTEM_FILES_DIR = $(LIBDAISY_DIR)/core
include $(SYSTEM_FILES_DIR)/Makefile

# Host-side unit tests (plain g++, no hardware): see tests/Makefile
.PHONY: test
test:
	$(MAKE) -C tests run
	@if command -v node >/dev/null 2>&1; then node --test '../site/tests/*.test.mjs'; else echo "node not found: skipping the studio tests (site/tests)"; fi

# Release build for users: no dev functions, internal flash only (BOOT_NONE), so it can be flashed
# in one step through the STM32 ROM bootloader (`make program-dfu`). Switching APP_TYPE needs a
# clean build, so this always starts from scratch. Result: build/bass_multiband.bin
.PHONY: release
release:
	$(MAKE) clean
	$(MAKE) BM_DEV=0 APP_TYPE=BOOT_NONE
