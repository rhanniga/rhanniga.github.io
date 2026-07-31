#!/usr/bin/env python3
"""safetensors -> .hslm

The highest-leverage file in the project for correctness. It owns three things
that are each capable of producing a model that sounds plausible and is wrong:

  1. The RoPE permutation. HuggingFace stores q/k projections for its half-split
     rotate_half; llama2.c rotates interleaved pairs. Converting the weights once
     here means the C never has to know, but getting it backwards yields fluent
     nonsense that reads like "it is just a small model". There is a numeric
     self-test (--verify) that proves the equivalence, plus a control proving the
     test is not vacuous.
  2. Quantization. Groups run along the INPUT dimension, which is the contiguous
     one in a row-major [out][in] matrix, and the group size must divide it
     exactly -- asserted rather than assumed.
  3. The header, which engine.h describes. If these two disagree the failure looks
     like a corrupt model rather than a bad reader.

No torch. safetensors hands back numpy directly, so quantizing needs nothing
heavier, and keeping torch out of this path means the converter runs anywhere.

Usage:
    convert.py --quant q4  -o smollm2-135m-q4.hslm
    convert.py --quant f32 -o smollm2-135m-f32.hslm   # for the golden test
    convert.py --verify                               # RoPE self-test only
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

import numpy as np

REPO = "HuggingFaceTB/SmolLM2-135M-Instruct"

MAGIC = b"HSLM"
VERSION = 1
HEADER_BYTES = 256
ALIGN = 16
GROUP_SIZE = 64
MAX_SEQ_LEN = 1024

Q_F32, Q_Q8, Q_Q4, Q_HYBRID = 0, 1, 2, 3
QUANT_NAMES = {"f32": Q_F32, "q8": Q_Q8, "q4": Q_Q4, "hybrid": Q_HYBRID}

# struct layout must match hslm_header in engine/engine.h exactly.
#   4s  magic
#   15i version dim hidden_dim n_layers n_heads n_kv_heads head_dim vocab_size
#       max_seq_len quant_type group_size tied_embeddings has_qkv_bias bos eos
#   2f  rms_eps rope_theta
#   32s sha256
#   152x padding
HEADER_FMT = "<4s15i2f32s152x"
assert struct.calcsize(HEADER_FMT) == HEADER_BYTES, struct.calcsize(HEADER_FMT)


# ── RoPE convention ────────────────────────────────────────────────────────


def unpermute(w: np.ndarray, n_heads: int, dim1: int, dim2: int) -> np.ndarray:
    """HuggingFace half-split layout -> Meta/llama2.c interleaved layout.

    The exact inverse of the `permute` in HF's own llama conversion script. HF
    pairs dimension i with i + head_dim/2; llama2.c pairs (2i, 2i+1).
    """
    return (
        w.reshape(n_heads, 2, dim1 // n_heads // 2, dim2)
        .swapaxes(1, 2)
        .reshape(dim1, dim2)
    )


def verify_rope(head_dim: int = 64, n_heads: int = 9, dim: int = 576,
                theta: float = 100000.0) -> bool:
    """Prove unpermute() + interleaved rotation == HF's rotate_half.

    Cheap here, ruinous to get wrong in C.
    """
    rng = np.random.default_rng(0)
    w = rng.standard_normal((n_heads * head_dim, dim)) * 0.02
    x = rng.standard_normal(dim)
    pos = 7

    inv = 1.0 / (theta ** (np.arange(0, head_dim, 2) / head_dim))
    ang = pos * inv
    cos_hf = np.concatenate([np.cos(ang), np.cos(ang)])
    sin_hf = np.concatenate([np.sin(ang), np.sin(ang)])

    def rotate_half(v):
        half = v.shape[-1] // 2
        return np.concatenate([-v[..., half:], v[..., :half]], axis=-1)

    q = (w @ x).reshape(n_heads, head_dim)
    ref = q * cos_hf + rotate_half(q) * sin_hf

    qm = (unpermute(w, n_heads, n_heads * head_dim, dim) @ x).reshape(n_heads, head_dim)
    got = np.empty_like(qm)
    c, s = np.cos(ang), np.sin(ang)
    got[:, 0::2] = qm[:, 0::2] * c - qm[:, 1::2] * s
    got[:, 1::2] = qm[:, 0::2] * s + qm[:, 1::2] * c
    # The conventions hold the same values in different slot orders.
    got_as_hf = np.concatenate([got[:, 0::2], got[:, 1::2]], axis=-1)

    err = float(np.abs(ref - got_as_hf).max())

    # Control: without the permutation it must NOT match, or the test proves
    # nothing at all.
    qb = (w @ x).reshape(n_heads, head_dim)
    bad = np.empty_like(qb)
    bad[:, 0::2] = qb[:, 0::2] * c - qb[:, 1::2] * s
    bad[:, 1::2] = qb[:, 0::2] * s + qb[:, 1::2] * c
    bad_err = float(np.abs(ref - np.concatenate([bad[:, 0::2], bad[:, 1::2]], -1)).max())

    print(f"  rope permutation      max err {err:.3e}   {'ok' if err < 1e-10 else 'FAIL'}")
    print(f"  control (unpermuted)  max err {bad_err:.3e}   "
          f"{'differs, so the test is meaningful' if bad_err > 1e-3 else 'VACUOUS TEST'}")
    return err < 1e-10 and bad_err > 1e-3


def rope_table(max_seq_len: int, head_dim: int, theta: float) -> np.ndarray:
    """[pos][head_dim/2][2] of (cos, sin), interleaved-pair convention.

    Shipped rather than computed so the freestanding wasm build needs no powf,
    sinf or cosf -- which leaves expf as the only math function to hand-write.
    """
    inv = 1.0 / (theta ** (np.arange(0, head_dim, 2, dtype=np.float64) / head_dim))
    pos = np.arange(max_seq_len, dtype=np.float64)[:, None]
    ang = pos * inv[None, :]
    out = np.empty((max_seq_len, head_dim // 2, 2), dtype=np.float32)
    out[:, :, 0] = np.cos(ang)
    out[:, :, 1] = np.sin(ang)
    return out


# ── Quantization ───────────────────────────────────────────────────────────


def sqnr_db(orig: np.ndarray, approx: np.ndarray) -> float:
    """Signal-to-quantization-noise ratio. Higher is better; <20 dB is trouble."""
    noise = float(np.sum((orig - approx) ** 2))
    if noise == 0.0:
        return float("inf")
    return 10.0 * np.log10(float(np.sum(orig**2)) / noise)


def quantize_q8(w: np.ndarray, group: int):
    """Symmetric int8, one fp32 scale per group along the input dim."""
    out_dim, in_dim = w.shape
    g = in_dim // group
    blocks = w.reshape(out_dim, g, group)
    amax = np.abs(blocks).max(axis=2)
    scale = (amax / 127.0).astype(np.float32)
    safe = np.where(scale == 0, 1.0, scale)[:, :, None]
    q = np.clip(np.rint(blocks / safe), -127, 127).astype(np.int8)
    deq = (q.astype(np.float32) * safe).reshape(out_dim, in_dim)
    return q.reshape(out_dim, in_dim), scale, deq


def quantize_q4(w: np.ndarray, group: int):
    """int4 packed 2/byte with an fp16 scale per group.

    Asymmetric in the llama.cpp Q4_0 sense: values land in [-8, 7], using the full
    16 codes rather than wasting one on symmetry. Products against int8-quantized
    activations then peak at 8 * 127 = 1016, which leaves ~32x of int16 headroom
    in the SIMD inner loop -- so accumulation can widen to i32 once per group
    rather than once per multiply.

    Packing puts element j and element j+32 in the two nibbles of byte j, so a
    16-byte SIMD load yields two *contiguous* 16-element runs after masking and
    shifting. Packing (2i, 2i+1) instead would interleave them and cost a shuffle
    in the hottest loop in the project.
    """
    out_dim, in_dim = w.shape
    assert group % 2 == 0
    g = in_dim // group
    blocks = w.reshape(out_dim, g, group).astype(np.float32)

    # Scale from the signed extremum, so the widest value maps to exactly -8.
    idx = np.abs(blocks).argmax(axis=2, keepdims=True)
    extremum = np.take_along_axis(blocks, idx, axis=2)[:, :, 0]
    d = (extremum / -8.0).astype(np.float32)
    safe = np.where(d == 0, 1.0, d)[:, :, None]

    q = np.clip(np.rint(blocks / safe) + 8, 0, 15).astype(np.uint8)

    half = group // 2
    lo = q[:, :, :half]
    hi = q[:, :, half:]
    packed = (lo | (hi << 4)).astype(np.uint8)  # [out][g][group/2]

    scale16 = d.astype(np.float16)
    deq_d = scale16.astype(np.float32)[:, :, None]
    deq = ((q.astype(np.float32) - 8.0) * deq_d).reshape(out_dim, in_dim)
    return packed.reshape(out_dim, in_dim // 2), scale16, deq


# ── Writing ────────────────────────────────────────────────────────────────


class Payload:
    """Accumulates aligned sections and reports what each one cost."""

    def __init__(self) -> None:
        self.parts: list[bytes] = []
        self.size = 0
        self.report: list[tuple[str, int, float | None]] = []

    def add(self, name: str, data: bytes, sqnr: float | None = None) -> None:
        pad = (-self.size) % ALIGN
        if pad:
            self.parts.append(b"\0" * pad)
            self.size += pad
        self.parts.append(data)
        self.size += len(data)
        self.report.append((name, len(data), sqnr))

    def bytes(self) -> bytes:
        return b"".join(self.parts)


def add_matrix(payload: Payload, name: str, w: np.ndarray, quant: int, group: int):
    """Quantize and append one [out][in] matrix, returning its SQNR."""
    out_dim, in_dim = w.shape
    if quant != Q_F32:
        # Asserted, not assumed: a group that does not divide the row length would
        # silently quantize across a row boundary.
        assert in_dim % group == 0, (
            f"{name}: group_size {group} does not divide input dim {in_dim}"
        )
        # Row starts must stay 16-byte aligned for SIMD loads.
        if quant in (Q_Q4,):
            assert (in_dim // 2) % ALIGN == 0, f"{name}: q4 row stride unaligned"

    if quant == Q_F32:
        payload.add(name, w.astype(np.float32).tobytes())
        return float("inf")
    if quant == Q_Q8:
        q, scale, deq = quantize_q8(w, group)
        payload.add(name, q.tobytes() + scale.tobytes(), sqnr_db(w, deq))
        return sqnr_db(w, deq)
    q, scale, deq = quantize_q4(w, group)
    payload.add(name, q.tobytes() + scale.tobytes(), sqnr_db(w, deq))
    return sqnr_db(w, deq)


class SafeTensors:
    """A minimal safetensors reader that understands bfloat16.

    safetensors' own numpy backend refuses bf16 -- numpy has no such dtype -- and
    these weights are stored bf16. Rather than pull in torch just to widen them,
    parse the container directly: it is an 8-byte little-endian header length, a
    JSON header, then raw tensor bytes at recorded offsets.

    bf16 -> fp32 is exact and needs no library: bf16 IS the top 16 bits of an
    fp32, so shifting left by 16 and reinterpreting is lossless.

    Tensors are widened on demand rather than all at once, which keeps peak memory
    at the file plus the single largest tensor instead of the whole model twice.
    """

    def __init__(self, path: Path) -> None:
        self.raw = path.read_bytes()
        (n,) = struct.unpack("<Q", self.raw[:8])
        self.header = json.loads(self.raw[8 : 8 + n])
        self.data_start = 8 + n

    def keys(self):
        return [k for k in self.header if k != "__metadata__"]

    def __getitem__(self, name: str) -> np.ndarray:
        meta = self.header[name]
        start, end = meta["data_offsets"]
        buf = self.raw[self.data_start + start : self.data_start + end]
        shape = tuple(meta["shape"])
        dtype = meta["dtype"]

        if dtype == "BF16":
            words = np.frombuffer(buf, dtype=np.uint16).astype(np.uint32) << 16
            return words.view(np.float32).reshape(shape)
        if dtype == "F16":
            return np.frombuffer(buf, dtype=np.float16).astype(np.float32).reshape(shape)
        if dtype == "F32":
            return np.frombuffer(buf, dtype=np.float32).reshape(shape)
        raise TypeError(f"{name}: unsupported dtype {dtype}")


def load_weights(local_dir: Path | None):
    from huggingface_hub import hf_hub_download

    if local_dir is not None:
        cfg = json.loads((local_dir / "config.json").read_text())
        tensors = SafeTensors(local_dir / "model.safetensors")
    else:
        cfg = json.loads(Path(hf_hub_download(REPO, "config.json")).read_text())
        tensors = SafeTensors(Path(hf_hub_download(REPO, "model.safetensors")))
    return cfg, tensors


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quant", choices=sorted(QUANT_NAMES), default="q4")
    ap.add_argument("-o", "--out", type=Path)
    ap.add_argument("--local", type=Path, help="directory holding config.json + model.safetensors")
    ap.add_argument("--max-seq-len", type=int, default=MAX_SEQ_LEN)
    ap.add_argument("--group", type=int, default=GROUP_SIZE)
    ap.add_argument("--verify", action="store_true", help="run the RoPE self-test and exit")
    args = ap.parse_args()

    print("RoPE convention self-test")
    ok = verify_rope()
    if not ok:
        print("\nABORT: the RoPE permutation does not reproduce HuggingFace.")
        return 1
    if args.verify:
        return 0
    if args.out is None:
        ap.error("-o/--out is required unless --verify")

    quant = QUANT_NAMES[args.quant]
    print(f"\nloading {REPO}")
    cfg, t = load_weights(args.local)

    dim = cfg["hidden_size"]
    hidden_dim = cfg["intermediate_size"]
    n_layers = cfg["num_hidden_layers"]
    n_heads = cfg["num_attention_heads"]
    n_kv_heads = cfg["num_key_value_heads"]
    head_dim = cfg.get("head_dim", dim // n_heads)
    vocab = cfg["vocab_size"]
    tied = bool(cfg.get("tie_word_embeddings", False))
    rms_eps = float(cfg["rms_norm_eps"])
    theta = float(cfg["rope_theta"])

    print(f"  dim={dim} hidden={hidden_dim} layers={n_layers} "
          f"heads={n_heads}/{n_kv_heads} head_dim={head_dim} vocab={vocab}")
    print(f"  tied_embeddings={tied} rms_eps={rms_eps} rope_theta={theta}")

    if not tied:
        print("  NOTE: embeddings are not tied; a separate lm_head would be needed")

    fp = lambda name: t[name].astype(np.float32)

    payload = Payload()

    # 1. RoPE table.
    payload.add("rope_table", rope_table(args.max_seq_len, head_dim, theta).tobytes())

    # 2. RMSNorm weights, fp32 always. They are tiny (35 KB total) and the most
    #    quantization-sensitive tensors in the model, so quantizing them would be
    #    all cost and no benefit.
    norms = []
    for i in range(n_layers):
        norms.append(fp(f"model.layers.{i}.input_layernorm.weight"))
        norms.append(fp(f"model.layers.{i}.post_attention_layernorm.weight"))
    norms.append(fp("model.norm.weight"))
    payload.add("norms", np.concatenate(norms).tobytes())

    # 3. Token embedding, which is also the lm_head when tied.
    embed = fp("model.embed_tokens.weight")
    assert embed.shape == (vocab, dim), embed.shape
    embed_quant = Q_Q8 if quant == Q_HYBRID else quant
    add_matrix(payload, "token_embedding", embed, embed_quant, args.group)

    # 4. Transformer blocks.
    block_quant = Q_Q4 if quant == Q_HYBRID else quant
    for i in range(n_layers):
        p = f"model.layers.{i}."
        wq = fp(p + "self_attn.q_proj.weight")
        wk = fp(p + "self_attn.k_proj.weight")
        # 🔴 The permutation. Applied here so the C can use one RoPE convention.
        wq = unpermute(wq, n_heads, n_heads * head_dim, dim)
        wk = unpermute(wk, n_kv_heads, n_kv_heads * head_dim, dim)

        for name, w in (
            ("wq", wq),
            ("wk", wk),
            ("wv", fp(p + "self_attn.v_proj.weight")),
            ("wo", fp(p + "self_attn.o_proj.weight")),
            ("w_gate", fp(p + "mlp.gate_proj.weight")),
            ("w_down", fp(p + "mlp.down_proj.weight")),
            ("w_up", fp(p + "mlp.up_proj.weight")),
        ):
            add_matrix(payload, f"layer{i}.{name}", w, block_quant, args.group)

    body = payload.bytes()
    digest = hashlib.sha256(body).digest()

    header = struct.pack(
        HEADER_FMT, MAGIC, VERSION, dim, hidden_dim, n_layers, n_heads, n_kv_heads,
        head_dim, vocab, args.max_seq_len, quant, args.group, int(tied), 0,
        int(cfg.get("bos_token_id", 1)), int(cfg.get("eos_token_id", 2)),
        rms_eps, theta, digest,
    )

    args.out.write_bytes(header + body)

    # ── Report ────────────────────────────────────────────────────────────
    print(f"\nwrote {args.out}  {len(header) + len(body):,} bytes "
          f"({(len(header) + len(body)) / 1024 / 1024:.1f} MiB)")
    print(f"  payload sha256 {digest.hex()[:32]}...")

    worst = [(n, s) for n, _, s in payload.report if s is not None and s != float("inf")]
    if worst:
        worst.sort(key=lambda kv: kv[1])
        print("\nSQNR, worst 8 tensors (dB; below ~20 is trouble):")
        for name, s in worst[:8]:
            print(f"  {name:24s} {s:6.2f}")
        print(f"  {'median':24s} {np.median([s for _, s in worst]):6.2f}")

    big = sorted(payload.report, key=lambda r: -r[1])[:5]
    print("\nlargest sections:")
    for name, nbytes, _ in big:
        print(f"  {name:24s} {nbytes / 1024 / 1024:8.2f} MiB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
