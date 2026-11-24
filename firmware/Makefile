# Project Name
TARGET = bass_multiband

# Uncomment to use LGPL (like ReverbSc, etc.)
#USE_DAISYSP_LGPL=1

# Build switches (always `make clean` when you change one; `make release` does it for you):
#   BM_REMOTE=1 (default): USB serial link with telemetry and remote commands, used by the
#                web studio (docs/PROTOCOL.md). In the dev AND the release build.
#                `make BM_REMOTE=0 BM_DEV=0` strips it (the effect only).
#   BM_DEV=1 (default):    development extras on top of the remote link (raw/UI/boot/save
#                lines, reboot/save/wipe/looptest commands). Release: `make release` (BM_DEV=0).
BM_DEV ?= 1
BM_REMOTE ?= 1
ifeq ($(BM_DEV),1)
ifneq ($(BM_REMOTE),1)
$(error BM_DEV=1 needs BM_REMOTE=1 (the dev extras use the USB serial link))
endif
C_DEFS += -DBM_DEV
endif
ifeq ($(BM_REMOTE),1)
C_DEFS += -DBM_REMOTE
endif

# Diagnostic build: ignore the inputs and output test tones instead
# (1 kHz on OUT L, 500 Hz on OUT R, -20 dBFS). Used to verify the output wiring.
BM_DIAG_TONE ?= 0
ifeq ($(BM_DIAG_TONE),1)
C_DEFS += -DBM_DIAG_TONE
endif

# Where the program lives (libDaisy core/Makefile understands these):
#   BOOT_SRAM (default, release and dev): the Daisy bootloader (internal flash, installed
#                        once with `make program-boot`) copies the program from the QSPI chip
#                        (0x90040000) into the fast RAM at power-up. Up to ~480 KB.
#   BOOT_NONE:           internal flash only, 128 KB, no Daisy bootloader. Emergency layout
#                        only: the release build with the remote link does not fit, use
#                        `make BM_DEV=0 BM_REMOTE=0 APP_TYPE=BOOT_NONE`.
#   BOOT_QSPI:           runs in place from the QSPI chip (not used: the chip cannot be written
#                        while code runs from it, and the settings are saved there).
# `make program-dfu` flashes the program to the address of the selected layout.
APP_TYPE ?= BOOT_SRAM

# Hothouse hardware wrapper, libDaisy and DaisySP come from the lib/HothouseExamples
# submodule (pinned; `git submodule update --init --recursive` fetches them).
HOTHOUSE_DIR = ../lib/HothouseExamples

# Target board: `make BOARD=funbox` builds for the GuitarML FunBox (v1-v3), board/funbox.cpp,
# instead of the Cleveland Music Co. Hothouse. Always `make clean` when you change it.
BOARD ?= hothouse
ifeq ($(BOARD),funbox)
BOARD_SRC = board/funbox.cpp
C_DEFS += -DBM_BOARD_FUNBOX=1
else ifeq ($(BOARD),hothouse)
BOARD_SRC = $(HOTHOUSE_DIR)/src/hothouse.cpp
else
$(error BOARD must be hothouse or funbox)
endif

# Sources and header files (the Hothouse headers stay on the path: libDaisy/DaisySP come from there)
CPP_SOURCES = bass_multiband.cpp $(BOARD_SRC)
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
	$(MAKE) -C virtual unit
	@if command -v node >/dev/null 2>&1; then node --test '../site/tests/*.test.mjs'; else echo "node not found: skipping the studio tests (site/tests)"; fi

# Release build for users: no dev extras, remote link included, BOOT_SRAM layout (program in
# the QSPI chip at 0x90040000, started by the Daisy bootloader). Switching options needs a
# clean build, so this always starts from scratch. Result: build/bass_multiband.bin
# Flash: `make program-dfu` with the pedal in the Daisy bootloader (or tools/flash.sh).
.PHONY: release
release:
	$(MAKE) clean
	$(MAKE) BM_DEV=0 BM_REMOTE=1 APP_TYPE=BOOT_SRAM BOARD=$(BOARD)
