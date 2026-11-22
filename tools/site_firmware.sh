#!/bin/bash
# Puts the release firmware next to the website, exactly as the Pages workflow does:
# site/firmware/{bass_multiband.bin, dsy_bootloader_*.bin, LICENSE-libDaisy.txt, manifest.json}.
# The web installer (site/js/flasher) reads manifest.json; its keys are fixed.
#
#   tools/site_firmware.sh            use firmware/build/bass_multiband.bin as it is
#   tools/site_firmware.sh --build    run `make -C firmware release` first
#
# Environment: COMMIT (default: git rev-parse HEAD).
set -eu
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--build" ]; then
  if [ -n "${ARM_TOOLCHAIN_BIN:-}" ]; then export PATH="$ARM_TOOLCHAIN_BIN:$PATH"; fi
  make -C firmware release
fi

out=site/firmware
app=firmware/build/bass_multiband.bin
boot=lib/HothouseExamples/libDaisy/core/dsy_bootloader_v6_2-intdfu-2000ms.bin
[ -f "$app" ] || { echo "missing $app: run with --build (or make -C firmware release)"; exit 1; }

mkdir -p "$out"
cp "$app" "$out/bass_multiband.bin"
cp "$boot" "$out/$(basename "$boot")"
cp lib/HothouseExamples/libDaisy/LICENSE "$out/LICENSE-libDaisy.txt"  # MIT notice for the bootloader

commit="${COMMIT:-$(git rev-parse HEAD)}"
version="$(sed -n 's/^#define BM_FW_VERSION "\(.*\)"$/\1/p' firmware/version.h)"
[ -n "$version" ] || { echo "BM_FW_VERSION not found in firmware/version.h"; exit 1; }
boot_version="$(basename "$boot" | sed -n 's/^dsy_bootloader_v\([0-9]*\)_\([0-9]*\)-.*/\1.\2/p')"
if command -v sha256sum >/dev/null; then sha() { sha256sum "$1" | cut -d' ' -f1; }
else sha() { shasum -a 256 "$1" | cut -d' ' -f1; }; fi
size() { wc -c < "$1" | tr -d ' '; }

cat > "$out/manifest.json" <<MANIFEST
{ "name": "Hothouse Bass Multiband", "version": "${version}", "commit": "${commit}",
  "app":        { "file": "bass_multiband.bin", "size": $(size "$out/bass_multiband.bin"), "sha256": "$(sha "$out/bass_multiband.bin")", "address": "0x90040000", "type": "boot_sram" },
  "bootloader": { "file": "$(basename "$boot")", "size": $(size "$boot"), "sha256": "$(sha "$boot")", "address": "0x08000000", "version": "${boot_version}", "license": "MIT (libDaisy)" } }
MANIFEST
python3 -m json.tool "$out/manifest.json" >/dev/null
echo "site/firmware: version $version, program $(size "$out/bass_multiband.bin") bytes, bootloader v$boot_version"
