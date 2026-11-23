# The virtual pedal (docs/VIRTUAL.md): the firmware's DSP and UI logic without
# the hardware, as WebAssembly for the web page and as a native build for tests.
#
#   make -C firmware/virtual           build site/wasm/virtual_pedal.wasm (needs Emscripten)
#   make -C firmware/virtual unit      C++ unit tests (g++ only)
#   make -C firmware/virtual test      unit tests, then the node tests: native-vs-wasm parity and the JS side
#   make -C firmware/virtual clean
#
# Emscripten: the emsdk version CI uses is pinned in .github/workflows (EMSDK_VERSION).
# Activate it in your shell first (`source <emsdk>/emsdk_env.sh`), or set EMCC.
EMCC ?= emcc
CXX ?= g++
FW = ..
INCLUDES = -I$(FW) -I$(FW)/../devkit/firmware
# -ffp-contract=off: no fused multiply-add, so native and wasm round the same way.
COMMON = -std=c++17 -Wall -Wextra -Werror -ffp-contract=off -DBM_CHAIN_TAPS $(INCLUDES)

WASM = ../../site/wasm/virtual_pedal.wasm
BUILD = build
DRIVER = $(BUILD)/vp_driver
SOURCES = abi.cpp $(wildcard *.h) $(wildcard $(FW)/dsp/*.h) $(wildcard $(FW)/ui/*.h) \
          $(FW)/version.h $(wildcard $(FW)/../devkit/firmware/*.h)

.PHONY: all wasm driver unit parity test clean
all: wasm

wasm: $(WASM)

$(WASM): $(SOURCES)
	@command -v $(EMCC) >/dev/null 2>&1 || { echo "emcc not found: activate the pinned emsdk first (see the header of this Makefile)"; exit 1; }
	@mkdir -p $(dir $@)
	$(EMCC) $(COMMON) -O2 -DNDEBUG -fno-exceptions -fno-rtti abi.cpp -o $@ \
	  -sSTANDALONE_WASM -sFILESYSTEM=0 -sINITIAL_MEMORY=4MB -sALLOW_MEMORY_GROWTH=0 \
	  -sSTACK_SIZE=131072 --no-entry
	@ls -l $@

# The native twin of the wasm module for the parity test: the same abi.cpp.
driver: $(DRIVER)

$(DRIVER): abi.cpp tests/vp_driver.cpp $(SOURCES)
	@mkdir -p $(BUILD)
	$(CXX) $(COMMON) -O2 abi.cpp tests/vp_driver.cpp -o $@

unit:
	$(MAKE) -C tests run

parity: $(WASM) $(DRIVER)
	node --test ../../site/tests/virtual-parity.test.mjs ../../site/tests/virtual-pedal.test.mjs

test: unit parity

clean:
	rm -rf $(BUILD) tests/build
