#!/usr/bin/env python3
"""tokenizer.json -> a compact binary the browser can load.

HuggingFace's tokenizer.json is 3.7 MB of JSON carrying a great deal the browser
does not need. This strips it to what encode and decode actually require.

SmolLM2's tokenizer is byte-level BPE, but NOT vanilla GPT-2, and two differences
would silently corrupt every prompt if missed:

  1. The pre-tokenizer is a Sequence: `Digits(individual_digits=true)` runs BEFORE
     ByteLevel. Every digit becomes its own token -- "2023" is four ids, not one.
  2. There are 17 special tokens (ids 0-16) which must be matched literally and
     never passed through BPE.

Both are asserted here rather than assumed, so a future tokenizer with a different
pre-tokenizer chain fails loudly instead of producing plausible garbage.

    tools/export_tokenizer.py                 # -> site/data/tokenizer.bin
    tools/export_tokenizer.py --c-array       # -> engine/tokenizer_debug.c
"""

from __future__ import annotations

import argparse
import gzip
import json
import struct
from pathlib import Path

REPO = "HuggingFaceTB/SmolLM2-135M-Instruct"
ROOT = Path(__file__).resolve().parent.parent

MAGIC = b"HTOK"
VERSION = 2

# The GPT-2 byte<->unicode map. Bytes that are not printable ASCII are moved into
# the U+0100..U+01FF range so that every byte has a single-character
# representation which never collides with a real character.
def bytes_to_unicode() -> dict[int, str]:
    bs = (
        list(range(ord("!"), ord("~") + 1))
        + list(range(ord("\xa1"), ord("\xac") + 1))
        + list(range(ord("\xae"), ord("\xff") + 1))
    )
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return {b: chr(c) for b, c in zip(bs, cs)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=ROOT / "site" / "data" / "tokenizer.bin")
    ap.add_argument("--c-array", action="store_true",
                    help="also emit engine/tokenizer_debug.c (decode only, native builds)")
    args = ap.parse_args()

    from huggingface_hub import hf_hub_download

    spec = json.loads(Path(hf_hub_download(REPO, "tokenizer.json")).read_text())

    # ── Assert the pipeline is the one this exporter understands ──────────
    assert spec.get("normalizer") is None, "a normalizer would change the text"
    assert spec.get("post_processor") is None, "a post-processor would add tokens"
    pre = spec["pre_tokenizer"]
    assert pre["type"] == "Sequence", pre["type"]
    kinds = [p["type"] for p in pre["pretokenizers"]]
    assert kinds == ["Digits", "ByteLevel"], kinds
    digits, bytelevel = pre["pretokenizers"]
    assert digits["individual_digits"] is True, "expected individual_digits"
    assert bytelevel["add_prefix_space"] is False, "expected no prefix space"
    assert bytelevel["use_regex"] is True, "expected the GPT-2 split regex"

    model = spec["model"]
    assert model["type"] == "BPE", model["type"]
    assert model["dropout"] is None
    assert model["unk_token"] is None, "no UNK: every byte is representable"
    assert model["continuing_subword_prefix"] is None
    assert model["end_of_word_suffix"] is None
    assert model["byte_fallback"] is False
    assert model["ignore_merges"] is False

    vocab: dict[str, int] = model["vocab"]
    merges: list[str] = model["merges"]
    n_vocab = len(vocab)

    # id -> token string
    id_to_tok = [""] * n_vocab
    for tok, tid in vocab.items():
        id_to_tok[tid] = tok

    # ── Merge table ──────────────────────────────────────────────────────
    # Working in id space rather than string space is what makes the browser's BPE
    # loop fast: every BPE symbol is itself a vocab entry, so a merge is a lookup on
    # a pair of integers rather than a string concatenation.
    #
    # And the merged id is not stored, because it is derivable. A BPE vocabulary is
    # built by applying merges in rank order, so merge r always produces id
    # MERGE_BASE + r. Verified below for all 48900 merges, and it checks out
    # exactly: 17 specials + 235 byte tokens + 48900 merges = 49152 = the vocab size,
    # with nothing left over.
    pairs = []
    merge_base = None
    for rank, m in enumerate(merges):
        left, right = m.split(" ") if isinstance(m, str) else m
        a, b = vocab.get(left), vocab.get(right)
        joined = vocab.get(left + right)
        assert a is not None and b is not None, f"merge {rank} references unknown token"
        assert joined is not None, f"merge {rank} produces a token not in the vocab"
        assert max(a, b, joined) < 65536, "ids must fit in u16"
        if merge_base is None:
            merge_base = joined - rank
        assert joined - rank == merge_base, (
            f"merge {rank} breaks the base+rank invariant "
            f"(expected {merge_base + rank}, got {joined})"
        )
        pairs.append((a, b))

    # ── The 256 byte tokens ──────────────────────────────────────────────
    # 21 of them are absent from this vocabulary, which was a surprise -- vanilla
    # GPT-2 has all 256. HuggingFace SILENTLY DROPS an unrepresentable byte
    # (verified: "a\x04b" encodes to [81, 82] and decodes to "ab"), and with
    # unk_token null and byte_fallback false there is nothing else it could do.
    #
    # NO_TOKEN marks them so the browser can drop them identically. Most cannot
    # occur in valid UTF-8 at all (0xC0, 0xC1, 0xF5-0xFF); the rest are control
    # characters, which the paste sanitizer already strips before text gets here.
    NO_TOKEN = 0xFFFF
    b2u = bytes_to_unicode()
    u2b = {ch: b for b, ch in b2u.items()}
    byte_ids = []
    dropped = []
    for b in range(256):
        tid = vocab.get(b2u[b])
        if tid is None:
            dropped.append(b)
            byte_ids.append(NO_TOKEN)
        else:
            byte_ids.append(tid)

    specials = sorted(
        (a for a in spec.get("added_tokens", []) if a.get("special")),
        key=lambda a: a["id"],
    )
    assert [a["id"] for a in specials] == list(range(len(specials))), \
        "specials are assumed to occupy ids 0..n-1"
    assert 17 + (256 - len(dropped)) + len(pairs) == n_vocab, \
        "vocab is not exactly specials + byte tokens + merge results"

    # ── Pack ─────────────────────────────────────────────────────────────
    # Deliberately does NOT ship the vocabulary strings. They are entirely
    # reconstructible: a byte token is one byte, a special is its literal text, and
    # every other token is the concatenation of the two it was merged from. The
    # browser rebuilds all 332 KB of it in one pass at load. Shipping half a
    # megabyte of derivable data would be the single biggest avoidable cost in the
    # whole download path.
    special_lens = bytearray()
    special_blob = bytearray()
    for a in specials:
        raw = a["content"].encode("utf-8")
        assert len(raw) < 256
        special_lens.append(len(raw))
        special_blob += raw

    out = bytearray()
    out += MAGIC
    out += struct.pack("<IIIIHH", VERSION, n_vocab, len(pairs), merge_base,
                       len(specials), len(special_blob))
    for tid in byte_ids:
        out += struct.pack("<H", tid)
    out += bytes(special_lens)
    out += bytes(special_blob)
    for a, b in pairs:
        out += struct.pack("<HH", a, b)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(bytes(out))

    reconstructed = sum(len(bytes(u2b[c] for c in t)) for t in vocab)
    print(f"wrote {args.out.relative_to(ROOT)}")
    print(f"  vocab      {n_vocab}  (17 special + {256 - len(dropped)} byte + {len(pairs)} merged)")
    print(f"  merges     {len(pairs)}   merged id = {merge_base} + rank")
    print(f"  specials   {len(specials)}  ids {[s['id'] for s in specials]}")
    print(f"  byte gaps  {len(dropped)} of 256 have no token: {dropped}")
    print(f"  NOT shipped: {reconstructed:,} bytes of vocabulary strings, rebuilt at load")

    gz = len(gzip.compress(bytes(out), 9))
    src = Path(hf_hub_download(REPO, "tokenizer.json")).stat().st_size
    print(f"  raw        {len(out):,} bytes ({len(out) / 1024:.0f} KiB)")
    print(f"  gzipped    {gz:,} bytes ({gz / 1024:.0f} KiB)  <- what is served")
    print(f"  vs source  {src:,} bytes tokenizer.json "
          f"({src / len(out):.1f}x smaller raw)")

    if args.c_array:
        # Decode only, and never compiled into the wasm build: main_native.c needs
        # to turn generated ids back into text, and encode genuinely never exists
        # in C.
        dst = ROOT / "engine" / "tokenizer_debug.c"
        with dst.open("w") as f:
            f.write("/* GENERATED by tools/export_tokenizer.py -- do not edit.\n"
                    " *\n"
                    " * Decode-only token table, for the native CLI. Excluded from the wasm\n"
                    " * build: encoding is JavaScript's job, so the engine's entire input\n"
                    " * surface is an array of ids and no tokenizer exists in C at all.\n"
                    " */\n")
            f.write("#ifdef ML_NATIVE\n")
            f.write(f"const int hslm_n_vocab = {n_vocab};\n")
            f.write("const char *const hslm_vocab[] = {\n")
            for tok in id_to_tok:
                esc = tok.encode("utf-8").decode("latin-1")
                esc = "".join(
                    f"\\{ord(c):03o}" if ord(c) < 32 or ord(c) > 126 or c in '"\\' else c
                    for c in esc
                )
                f.write(f'  "{esc}",\n')
            f.write("};\n#endif\n")
        print(f"  also wrote {dst.relative_to(ROOT)} ({dst.stat().st_size:,} bytes)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
