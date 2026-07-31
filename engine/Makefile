# Two targets from one set of engine sources.
#
# engine.c and matmul.c include only engine.h and platform.h, so the same code
# builds natively -- where gdb, ASan and valgrind all work -- and freestanding for
# wasm, where none of them do. main_native.c and trace.c are never compiled for
# wasm.

CC      ?= cc
OUT     ?= ../site/ask

ENGINE_SRC := engine.c matmul.c
NATIVE_SRC := $(ENGINE_SRC) platform_native.c main_native.c trace.c

WARN := -Wall -Wextra -Wshadow -Wconversion -Wno-sign-conversion -Wpointer-arith

.PHONY: all native trace asan debug clean test help

all: native

## native: optimised native binary
native:
	$(CC) -O2 -std=c11 $(WARN) -DML_NATIVE=1 -o engine $(NATIVE_SRC) -lm

## trace: native binary with per-layer checksum instrumentation, for bisecting
## a divergence from the PyTorch reference
trace:
	$(CC) -O2 -g -std=c11 $(WARN) -DML_NATIVE=1 -DML_TRACE=1 \
	  -o engine-trace $(NATIVE_SRC) -lm

## asan: address + undefined-behaviour sanitizers
asan:
	$(CC) -O1 -g -std=c11 $(WARN) -DML_NATIVE=1 \
	  -fsanitize=address,undefined -fno-omit-frame-pointer \
	  -o engine-asan $(NATIVE_SRC) -lm

## debug: unoptimised, for stepping through
debug:
	$(CC) -O0 -g3 -std=c11 $(WARN) -DML_NATIVE=1 -DML_TRACE=1 \
	  -o engine-debug $(NATIVE_SRC) -lm

## test: scalar matmul self-checks
test:
	$(CC) -O2 -g -std=c11 $(WARN) -DML_NATIVE=1 \
	  -o tests/test_matmul tests/test_matmul.c matmul.c platform_native.c -lm
	./tests/test_matmul

clean:
	rm -f engine engine-trace engine-asan engine-debug tests/test_matmul
	rm -f $(OUT)/engine.wasm $(OUT)/engine.simd.wasm

help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  /'
