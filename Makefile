# sanoMIT — build and test
#
#   make            host CLI + wasm engine
#   make test       the gates: front end, then engine (wasm, and native parity)
#   make baseline   re-record test/baseline.json from this build
#   make clean
#
# The wasm build needs emsdk on the PATH (source ~/emsdk/emsdk_env.sh).
# The host build needs nothing but a C compiler.

ROOT     := $(abspath .)
DIST     := $(ROOT)/dist
INC      := -I$(ROOT)/runtime/include -I$(ROOT)/runtime/models/en_us_e13b
CORE     := runtime/src/snt_nano.c runtime/src/snt_kernels_ref.c
CC       ?= cc
CFLAGS   ?= -O2 -std=c99 -Wall -Wextra

HOST_SRC := $(CORE) runtime/ports/host/snt_port_host.c runtime/ports/host/smit_host.c
WASM_SRC := $(CORE) runtime/ports/wasm/smit_wasm.c runtime/ports/wasm/smit_port_wasm.c

.PHONY: all host wasm test test-g2p test-engine provenance clean baseline data

all: host wasm

host: $(DIST)/smit_host

$(DIST)/smit_host: $(HOST_SRC) runtime/include/snt_nano.h runtime/include/snt_port.h
	@mkdir -p $(DIST)
	$(CC) $(CFLAGS) $(INC) $(HOST_SRC) -lm -o $@
	@echo "built dist/smit_host"

wasm:
	@./tools/build-wasm.sh

test: test-g2p test-engine

test-g2p:
	@node test/g2p-test.js

test-engine: $(DIST)/smit_host
	@node test/engine-test.js

baseline: $(DIST)/smit_host
	@node test/engine-test.js --update

# Is the fork still the fork, and has any GPL code crept in?
provenance:
	@node tools/check-provenance.js

data:
	@./tools/get-data.sh

clean:
	rm -f $(DIST)/smit_host $(DIST)/sanomit.js $(DIST)/sanomit.wasm
	rm -f $(DIST)/test-render.wav $(DIST)/test-ids.txt
