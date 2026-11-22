#!/bin/bash
# Flashing helper for the pedal. Needs dfu-util and the arm-none-eabi toolchain
# (on PATH, or set ARM_TOOLCHAIN_BIN to its bin/ directory).
#
# Both the release and the dev build use the BOOT_SRAM layout: the Daisy bootloader
# lives in the internal flash, the program in the QSPI chip at 0x90040000.
#
#   tools/flash.sh setup [release|dev]   ONCE (or after other firmware): installs the Daisy
#                                        bootloader, then the program. The pedal must be in the
#                                        STM32 ROM bootloader: hold FS1+FS2 for ~2 s while the old
#                                        firmware runs (if it supports that), or BOOT+RESET on the Daisy.
#   tools/flash.sh app [dev|release]     flash a new program (the Daisy bootloader is already
#                                        installed). Enter the bootloader with FS1+FS2 for 2-3 s
#                                        (LEDs alternate), the `dfu` command, or power-cycle and
#                                        flash within the bootloader's 2 s window.
#   tools/flash.sh internal              EMERGENCY ONLY: effect without the USB link (BM_REMOTE=0)
#                                        in the internal flash (BOOT_NONE), through the ROM DFU.
#                                        Overwrites the Daisy bootloader (`setup` brings it back).
#
# The default variant is dev. The message "Error during download get_status" at the
# very end is harmless.
set -e
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")/../firmware"
if [ -n "${ARM_TOOLCHAIN_BIN:-}" ]; then export PATH="$ARM_TOOLCHAIN_BIN:$PATH"; fi
command -v arm-none-eabi-gcc >/dev/null || { echo "arm-none-eabi-gcc not found: put it on PATH or set ARM_TOOLCHAIN_BIN"; exit 1; }
command -v dfu-util >/dev/null || { echo "dfu-util not found"; exit 1; }
QSPI_ADDRESS=0x90040000
INTERNAL_ADDRESS=0x08000000
BOOTLOADER=../lib/HothouseExamples/libDaisy/core/dsy_bootloader_v6_2-intdfu-2000ms.bin

usage() { sed -n 2,21p "$SELF"; exit 2; }

mode=${1:-}
variant=${2:-dev}
case "$variant" in
  dev) dev=1 ;;
  release) dev=0 ;;
  *) usage ;;
esac

build() {
  echo "== building ($variant, BOOT_SRAM: program in QSPI, started by the Daisy bootloader)"
  make clean >/dev/null
  if [ "$variant" = "release" ]; then
    make release 2>&1 | grep -E "warning|error|SRAM:" | grep -v "is not implemented\|RWX" || true
  else
    make BM_DEV=1 APP_TYPE=BOOT_SRAM 2>&1 | grep -E "warning|error|SRAM:" | grep -v "is not implemented\|RWX" || true
  fi
  [ -f build/bass_multiband.bin ] || { echo "build failed"; exit 1; }
}

require_rom_dfu() {
  echo "== checking that the pedal is in the STM32 ROM bootloader"
  if ! dfu-util -l 2>/dev/null | grep -q "Internal Flash"; then
    echo "Pedal not found in the STM32 ROM bootloader."
    echo "Hold FS1+FS2 for ~2 s while the old firmware runs (LEDs alternate), or press BOOT+RESET on the Daisy, then run this again."
    exit 1
  fi
}

flash_app() {
  echo "== waiting for the Daisy bootloader (hold FS1+FS2 for 2-3 s, send 'dfu', or power-cycle and wait)"
  dfu-util -w -a 0 -s ${QSPI_ADDRESS}:leave -D build/bass_multiband.bin -d ,0483:df11 || true
  echo "== done. If the LEDs blinked 3 times the new program is running."
}

case "$mode" in
  setup)
    require_rom_dfu
    build
    echo "== installing the Daisy bootloader into the internal flash"
    dfu-util -a 0 -s ${INTERNAL_ADDRESS}:leave -D "$BOOTLOADER" -d ,0483:df11 || true
    echo "== the pedal restarts into the Daisy bootloader; giving it a moment"
    sleep 4
    flash_app
    ;;
  app)
    build
    flash_app
    ;;
  internal)
    require_rom_dfu
    echo "== building the emergency firmware (BM_DEV=0 BM_REMOTE=0, BOOT_NONE, internal flash)"
    make clean >/dev/null
    make BM_DEV=0 BM_REMOTE=0 APP_TYPE=BOOT_NONE 2>&1 | grep -E "warning|error|FLASH:|SRAM:" | grep -v "is not implemented\|RWX" || true
    [ -f build/bass_multiband.bin ] || { echo "build failed"; exit 1; }
    dfu-util -a 0 -s ${INTERNAL_ADDRESS}:leave -D build/bass_multiband.bin -d ,0483:df11 || true
    make clean >/dev/null  # the next normal build must not reuse BOOT_NONE objects
    echo "== done. If the LEDs blinked 3 times the program is running."
    ;;
  *)
    usage
    ;;
esac
