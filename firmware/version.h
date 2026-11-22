// Firmware and serial protocol version: the single source for the `hello`
// reply (docs/PROTOCOL.md) and for the manifest the Pages workflow writes.
// Keep the format of the two lines below: CI reads BM_FW_VERSION with sed.
#pragma once

#define BM_FW_VERSION "0.1.0-beta"
#define BM_PROTO_VERSION 1
