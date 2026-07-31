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

# ── wasm ─────────────────────────────────────────────────────────────────
# Plain clang, freestanding. Emscripten's value proposition is JS glue and a
# libc; this ABI is nineteen functions taking only i32/f32, so there is nothing
# to glue, and platform_wasm.c IS the libc requirement. Result: ~50KB with zero
# imports, versus emsdk's ~1GB install and 60-120s CI cost.
WASM_CC   ?= clang
WASM_SRC  := $(ENGINE_SRC) platform_wasm.c

WASM_ARCH := --target=wasm32-unknown-unknown -mcpu=mvp \
             -mbulk-memory -msign-ext -mmutable-globals -mnontrapping-fptoint

# NOT -ffast-math: -ffinite-math-only lets the optimiser assume no NaN or Inf and
# can emit calls into a vector libm that does not exist here. These narrower flags
# give FMA contraction and no errno writes, which is all that is wanted.
WASM_OPT  := -O3 -flto -fno-math-errno -ffp-contract=fast -fno-trapping-math \
             -fomit-frame-pointer
WASM_ENV  := -nostdlib -ffreestanding -fvisibility=hidden -DML_WASM=1

# The explicit export list IS the ABI, spelled out in one place; --gc-sections then
# strips everything else. Memory is exported rather than imported, so JS needs no
# import object at all.
WASM_EXPORTS := ml_alloc ml_arena_reset ml_init ml_shutdown \
                ml_n_vocab ml_n_ctx ml_eos_id ml_bos_id \
                ml_kv_bytes ml_kv_save ml_kv_load ml_model_sha256 \
                ml_seed ml_forward ml_logits ml_sample ml_history_clear
WASM_LD := -Wl,--no-entry -Wl,--lto-O3 -Wl,--strip-all -Wl,--gc-sections \
           -Wl,--initial-memory=2097152 -Wl,--max-memory=268435456 \
           -Wl,-z,stack-size=262144 -Wl,--export-memory \
           $(foreach f,$(WASM_EXPORTS),-Wl,--export=$(f))

.PHONY: all native trace asan debug clean test help wasm wasm-scalar

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

## wasm: the shipped module, with SIMD
wasm:
	@mkdir -p $(OUT)
	$(WASM_CC) $(WASM_ARCH) -msimd128 $(WASM_OPT) $(WASM_ENV) $(WASM_LD) \
	  -o $(OUT)/engine.simd.wasm $(WASM_SRC)
	@ls -l $(OUT)/engine.simd.wasm | awk '{printf "  engine.simd.wasm  %d bytes\n", $$5}'

## wasm-scalar: same sources without SIMD. Kept because it is how the SIMD
## speedup is measured, and because it is the fallback for pre-2023 Safari.
wasm-scalar:
	@mkdir -p $(OUT)
	$(WASM_CC) $(WASM_ARCH) $(WASM_OPT) $(WASM_ENV) $(WASM_LD) \
	  -o $(OUT)/engine.wasm $(WASM_SRC)
	@ls -l $(OUT)/engine.wasm | awk '{printf "  engine.wasm       %d bytes\n", $$5}'

clean:
	rm -f engine engine-trace engine-asan engine-debug tests/test_matmul
	rm -f $(OUT)/engine.wasm $(OUT)/engine.simd.wasm

help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  /'
