# Installing Bandwerk

You can install and update the firmware from the project website, directly from the browser. No software,
no toolchain. This page explains the web installer, what to do when something does not work, and how to do the same
with `dfu-util` instead.

## What you need

- A Hothouse pedal or a GuitarML FunBox (v1-v3), each with a Daisy Seed inside, and a USB **data** cable (some
  cables only charge).
- **Choose your board in the installer** ("Your pedal": Hothouse or FunBox v1-v3) before you flash. It is
  remembered in the browser and preselected when the pedal is connected over USB and reports its board. The two
  builds differ only in the toggle switch pins: a wrong choice does not harm the pedal, but the toggles will
  not respond. The FunBox build is supported but **not yet tested on FunBox hardware**; please report how it works.
- **Chrome, Edge or Opera on a desktop computer, or Chrome on Android.** The installer uses WebUSB, which Firefox,
  Safari and all browsers on iPhone/iPad do not have. In those browsers the installer page shows the alternatives
  below instead.
- Windows only: a one-time driver step (see [Windows](#windows)).

## How the firmware is installed

The program is larger than the 128 KB internal flash of the Daisy Seed, so it lives in the external QSPI flash and is
started by the **Daisy bootloader**:

| What | Where | Written through |
|---|---|---|
| Daisy bootloader (`dsy_bootloader_v6_2-intdfu-2000ms.bin`, libDaisy, MIT) | internal flash, `0x08000000` | the STM32's built-in ROM bootloader |
| Bandwerk (`bandwerk-<board>-<version>.bin`) | QSPI flash, `0x90040000` | the Daisy bootloader |
| Your saved settings | QSPI flash, start of the chip | written by the firmware, **never touched by the installer** |

The Daisy bootloader waits **2 seconds** after every power-up, then starts the program. A new pedal with no program
waits forever. A broken program can therefore always be replaced without opening the pedal, as long as you catch the 2 second window (see Recovery).

Both bootloaders show up on USB as `0483:df11`. The installer tells them apart by the memory map they report:
the ROM bootloader reports the internal flash at `0x08000000` (name "STM32 BOOTLOADER" in the browser dialog),
the Daisy bootloader reports the QSPI flash at `0x90000000` (name "Daisy Bootloader"). It refuses to write anything to a device
that is not the right one for the step it is doing.

## Update (the pedal already runs Bandwerk)

1. Open the installer and click **Update my pedal**.
2. Click **Restart pedal into update mode** and pick the pedal's serial port (close the Studio tab first, only one page can use
   the port). Alternatively hold **FS1 + FS2 for 2 seconds** until the LEDs alternate. In this mode the pedal waits as
   long as you like.
3. Click **Select pedal** and choose **Daisy Bootloader**. The installation starts at once: erase, write, restart. Do not
   unplug the pedal and keep the tab open until it says Done.

Your saved settings stay.

## First install (new pedal, or the pedal runs other firmware)

This replaces the firmware that is currently on the pedal.

1. Click **Install on a new pedal**.
2. Put the pedal into the STM32 ROM bootloader. On most Hothouse firmware, hold **FS1 + FS2 for 2 seconds**. If that does not
   work (or the pedal has no working firmware), open the pedal and use the Daisy Seed: hold **BOOT**, tap **RESET**, release
   **BOOT**.
3. Click **Select pedal** and choose **STM32 BOOTLOADER**. The installer writes the Daisy bootloader and verifies it by reading it back.
4. The pedal restarts as the Daisy bootloader. This is a *different USB device* for the browser, so a second prompt is needed:
   click **Select pedal** again and choose **Daisy Bootloader**. (If your browser already knows this device from an earlier
   install, it continues by itself.)
5. The installer writes the program and starts it.

### If the installer cannot find the pedal after step 3

- A new pedal waits for the installer without a time limit. Check the cable, the driver (Windows) and the browser dialog.
- A pedal that already had a program in the QSPI flash starts that program after 2 seconds. Hold **FS1 + FS2 for 2 seconds**
  (our firmware) to come back to update mode, or power-cycle it, then click **Select pedal**. The bootloader only stays in
  update mode once the installer has started erasing, so connect promptly after a power-cycle.

## Advanced options

- **Reinstall the bootloader** writes only the Daisy bootloader. Needs the ROM bootloader (BOOT + RESET). The program in the QSPI flash stays.
- **Flash your own program (.bin)** writes a file you built with `APP_TYPE = BOOT_SRAM` (or `BOOT_QSPI`) to `0x90040000`.
  The installer checks the size (at most 480 KB) and the vector table, and refuses programs built for the internal flash.
  Custom files are never written to the internal flash.

## FunBox notes

- The three toggle switches report **left = up** and **right = down** (the manual and the studio say left/right
  when a FunBox is connected). Everything else is as on the Hothouse: knobs 1-6, footswitches, LEDs, stereo in/out.
- The FX loop uses the ring of the TRS jacks as on the Hothouse (OUT R ring = send, IN R ring = return).
- The DIP switches, MIDI in and the expression input are not used for now.

## Platform notes

### Windows

The browser needs the **WinUSB** driver for the DFU device. Install it once per device with [Zadig](https://zadig.akeo.ie/):

1. Put the pedal into the mode you are about to use (ROM bootloader for a first install, Daisy bootloader for an update).
2. Start Zadig, menu **Options > List All Devices**.
3. Select **STM32 BOOTLOADER** (ROM) or **Daisy Bootloader**, choose **WinUSB** as the target driver, click **Replace Driver**.

On a first install you need this **twice**: Windows treats the Daisy bootloader as a new device and the WinUSB driver has to be
installed for it as well (reported by other Daisy users as well: the driver has to be reinstalled after the bootloader was flashed).

### Linux

Allow regular users to open the device, then replug it:

```sh
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="df11", MODE="0666"' | sudo tee /etc/udev/rules.d/99-hothouse-dfu.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

### macOS, ChromeOS, Android

Nothing to install. On Android use a USB OTG cable.

## Without the web installer: dfu-util

Install [dfu-util](https://dfu-util.sourceforge.net/) (macOS: `brew install dfu-util`). Download both files from the
[release page](https://github.com/schnell-auswahl/bandwerk/releases) (or from `site/firmware/` after a local build), and check them
against the `.sha256` files.

```sh
# 1. First install only. Pedal in the ROM bootloader (FS1+FS2 2 s, or BOOT+RESET):
dfu-util -a 0 -d 0483:df11 -s 0x08000000:leave -D dsy_bootloader_v6_2-intdfu-2000ms.bin

# 2. Pedal in the Daisy bootloader (appears by itself after step 1 on a new pedal; with our firmware: FS1+FS2 2 s):
dfu-util -a 0 -d 0483:df11 -s 0x90040000:leave -D bandwerk-hothouse.bin   # or bandwerk-funbox.bin
```

`-a 0` is the first alt setting, which is the flash in both bootloaders. Do not use other alt settings (option bytes!).

The [Daisy Web Programmer](https://flash.daisy.audio/) (Electro-Smith) is another browser tool; it also needs WebUSB.
Use it to install the Daisy bootloader and flash `bandwerk-hothouse.bin` (or `bandwerk-funbox.bin`) as a bootloader program (check its current instructions).

## Recovery

The built-in ROM bootloader of the STM32 cannot be overwritten by anything the installer does, so a pedal cannot be bricked by a failed install.

| Situation | What to do |
|---|---|
| The installer stopped or the tab was closed in the middle of writing the program | The Daisy bootloader is still there. Power-cycle the pedal: with an erased or clearly incomplete program it stays in update mode, then run **Update** again. If a half-written program starts and misbehaves, the bootloader still waits 2 seconds at each power-up: power-cycle and click **Select pedal** within 2 seconds (works when the browser already knows the pedal from an earlier install), or use the BOOT + RESET route below. |
| The installer stopped while writing the bootloader | The pedal may be dead until the bootloader is written again. Put it into the ROM bootloader (**BOOT + RESET** on the Daisy Seed) and run **First install** again. |
| The program is installed but behaves badly | Hold FS1 + FS2 for 2 seconds while it runs (if it still reacts), or power-cycle and click **Select pedal** within 2 seconds. |
| The pedal does not show up in the browser dialog | Another cable or USB port; close other programs using the pedal (Studio tab, serial monitors); Windows: Zadig; Linux: udev rule. |
| Everything is confusing | Unplug, hold BOOT, tap RESET (Daisy Seed), start **First install**. This always works. |
| You want a different firmware back | Put the pedal into the ROM bootloader and write that firmware's `.bin` (built for the internal flash) with `dfu-util -a 0 -d 0483:df11 -s 0x08000000:leave -D other.bin`. This replaces the Daisy bootloader; run **First install** later to get Bandwerk back. |

## Notes on what is verified

The installer verifies the size and the SHA-256 of both files against `firmware/manifest.json` before anything is written,
reads the bootloader back from the internal flash after writing it, and only ever writes the bootloader to `0x08000000`
(through the ROM bootloader) and programs to `0x90040000` (through the Daisy bootloader). The Daisy bootloader cannot be read back reliably, so the
program is not read back; the bootloader starts it only if its vector table is plausible.
