# tools

    python3 -m venv tools/.venv
    tools/.venv/bin/pip install -r tools/requirements.txt      # conversion
    tools/.venv/bin/pip install -r tools/requirements-dev.txt  # + goldens

Verified working on Python 3.14 with torch 2.13.0+cpu and transformers 5.14.1, so
the separate older-Python environment the plan hedged about is not needed. Install
torch from the CPU index to avoid pulling ~2.5 GB of CUDA:

    tools/.venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch

## What is here

| | |
|---|---|
| `convert.py` | safetensors -> `.hslm`. Owns the RoPE permutation, the shipped cos/sin table, and quantization. |
| `golden_logits.py` | PyTorch reference logits and layer checksums -> `engine/tests/fixtures/golden.json`. |
| `contrast.mjs` | WCAG audit of the Nord palette (node, no Python). |

`convert.py` is the highest-leverage file in the project for correctness: if the
RoPE permutation is wrong, the model produces fluent nonsense that reads like "it
is just a small model", and no amount of debugging the C will find it.
