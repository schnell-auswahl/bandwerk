#!/bin/bash
# Flashing helper for the pedal. Needs dfu-util and the arm-none-eabi toolchain
# (on PATH, or set ARM_TOOLCHAIN_BIN to its bin/ directory).
#
# Release build (BOOT_NONE, internal flash, one step, no bootloader):
#   tools/flash.sh release        build the release firmware and flash it through the STM32 ROM DFU
#                                 (pedal must be in the ROM bootloader: hold FS1+FS2 for ~2 s
#                                  while the firmware runs, or BOOT+RESET on the Daisy)
#
# Development build (BOOT_SRAM, Daisy bootloader, program runs from RAM):
#   tools/flash.sh setup          ONCE: installs the Daisy bootloader and the program
#                                 (pedal must be in the STM32 ROM bootloader, see above)
#   tools/flash.sh app            flash a new program (dev build)
#   tools/flash.sh app release    flash a new program (release build, no dev functions, BOOT_SRAM)
#
# Normal dev update: hold FS1+FS2 for 2-3 s (the LEDs alternate), then `tools/flash.sh app`.
# The message "Error during download get_status" at the very end is harmless.
set -e
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")/../firmware"
if [ -n "${ARM_TOOLCHAIN_BIN:-}" ]; then export PATH="$ARM_TOOLCHAIN_BIN:$PATH"; fi
command -v arm-none-eabi-gcc >/dev/null || { echo "arm-none-eabi-gcc not found: put it on PATH or set ARM_TOOLCHAIN_BIN"; exit 1; }
command -v dfu-util >/dev/null || { echo "dfu-util not found"; exit 1; }
QSPI_ADDRESS=0x90040000

mode=${1:-}
variant=${2:-dev}
dev=1; [ "$variant" = "release" ] && dev=0

build() {
  export APP_TYPE=BOOT_SRAM
  echo "== building ($variant, program runs from RAM, loaded by the Daisy bootloader)"
  make clean >/dev/null
  make BM_DEV=$dev 2>&1 | grep -E "warning|error|SRAM:" | grep -v "is not implemented\|RWX" || true
  [ -f build/bass_multiband.bin ] || { echo "build failed"; exit 1; }
}

flash_app() {
  echo "== waiting for the Daisy bootloader (hold FS1+FS2 for 2-3 s, or power-cycle and wait)"
  dfu-util -w -a 0 -s ${QSPI_ADDRESS}:leave -D build/bass_multiband.bin -d ,0483:df11 || true
  echo "== done. If the LEDs blinked 3 times the new program is running."
}

case "$mode" in
  release)
    echo "== checking that the pedal is in the STM32 ROM bootloader"
    if ! dfu-util -l 2>/dev/null | grep -q "Internal Flash"; then
      echo "Pedal not found in the STM32 ROM bootloader."
      echo "Hold FS1+FS2 for ~2 s while the firmware is running (LEDs alternate), or press BOOT+RESET on the Daisy, then run this again."
      exit 1
    fi
    echo "== building the release firmware (BM_DEV=0, BOOT_NONE)"
    make release 2>&1 | grep -E "warning|error|FLASH:|SRAM:" | grep -v "is not implemented\|RWX" || true
    [ -f build/bass_multiband.bin ] || { echo "build failed"; exit 1; }
    echo "== flashing the internal flash through the ROM DFU"
    make APP_TYPE=BOOT_NONE program-dfu || true
    echo "== done. If the LEDs blinked 3 times the new program is running."
    ;;
  setup)
    echo "== checking that the pedal is in the STM32 bootloader"
    if ! dfu-util -l 2>/dev/null | grep -q "Internal Flash"; then
      echo "Pedal not found in the STM32 bootloader."
      echo "Hold FS1+FS2 for 2-3 s while the OLD firmware is running (LEDs alternate), then run this again."
      exit 1
    fi
    build
    echo "== installing the Daisy bootloader (internal flash, once)"
    make APP_TYPE=BOOT_SRAM program-boot || true
    echo "== the pedal restarts into the bootloader; giving it a moment"
    sleep 4
    flash_app
    ;;
  app)
    build
    flash_app
    ;;
  *)
    sed -n 2,19p "$SELF"
    exit 2
    ;;
esac
