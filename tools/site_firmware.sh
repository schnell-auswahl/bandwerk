#!/bin/bash
# Puts the release firmware next to the website, exactly as the Pages workflow does:
# site/firmware/{bandwerk-hothouse.bin, bandwerk-funbox.bin, dsy_bootloader_*.bin, LICENSE-libDaisy.txt, manifest.json}.
# The web installer (site/js/flasher) reads manifest.json; its keys are fixed.
#
#   tools/site_firmware.sh            use firmware/.release-bins/<board>.bin as they are (left by an earlier --build)
#   tools/site_firmware.sh --build    build both release variants (BOARD=hothouse, BOARD=funbox) first
#
# Environment: COMMIT (default: git rev-parse HEAD), ARM_TOOLCHAIN_BIN.
set -eu
cd "$(dirname "$0")/.."

stash=firmware/.release-bins
boards="hothouse funbox"
if [ "${1:-}" = "--build" ]; then
  if [ -n "${ARM_TOOLCHAIN_BIN:-}" ]; then export PATH="$ARM_TOOLCHAIN_BIN:$PATH"; fi
  mkdir -p "$stash"
  for b in $boards; do
    make -C firmware release BOARD="$b"
    cp firmware/build/bass_multiband.bin "$stash/$b.bin"
  done
fi

out=site/firmware
boot=lib/HothouseExamples/libDaisy/core/dsy_bootloader_v6_2-intdfu-2000ms.bin
for b in $boards; do
  [ -f "$stash/$b.bin" ] || { echo "missing $stash/$b.bin: run with --build"; exit 1; }
done

mkdir -p "$out"
rm -f "$out/bass_multiband.bin"
for b in $boards; do cp "$stash/$b.bin" "$out/bandwerk-$b.bin"; done
cp "$boot" "$out/$(basename "$boot")"
cp lib/HothouseExamples/libDaisy/LICENSE "$out/LICENSE-libDaisy.txt"  # MIT notice for the bootloader

commit="${COMMIT:-$(git rev-parse HEAD)}"
version="$(sed -n 's/^#define BM_FW_VERSION "\(.*\)"$/\1/p' firmware/version.h)"
[ -n "$version" ] || { echo "BM_FW_VERSION not found in firmware/version.h"; exit 1; }
boot_version="$(basename "$boot" | sed -n 's/^dsy_bootloader_v\([0-9]*\)_\([0-9]*\)-.*/\1.\2/p')"
if command -v sha256sum >/dev/null; then sha() { sha256sum "$1" | cut -d' ' -f1; }
else sha() { shasum -a 256 "$1" | cut -d' ' -f1; }; fi
size() { wc -c < "$1" | tr -d ' '; }
app_entry() { echo "{ \"file\": \"bandwerk-$1.bin\", \"size\": $(size "$out/bandwerk-$1.bin"), \"sha256\": \"$(sha "$out/bandwerk-$1.bin")\", \"address\": \"0x90040000\", \"type\": \"boot_sram\" }"; }

cat > "$out/manifest.json" <<MANIFEST
{ "name": "Bandwerk", "version": "${version}", "commit": "${commit}",
  "boards": {
    "hothouse": { "label": "Cleveland Music Co. Hothouse",
      "app": $(app_entry hothouse) },
    "funbox": { "label": "GuitarML FunBox (v1\u2013v3)", "tested": false,
      "app": $(app_entry funbox) } },
  "bootloader": { "file": "$(basename "$boot")", "size": $(size "$boot"), "sha256": "$(sha "$boot")", "address": "0x08000000", "version": "${boot_version}", "license": "MIT (libDaisy)" } }
MANIFEST
python3 -m json.tool "$out/manifest.json" >/dev/null
echo "site/firmware: version $version, hothouse $(size "$out/bandwerk-hothouse.bin") bytes, funbox $(size "$out/bandwerk-funbox.bin") bytes, bootloader v$boot_version"
