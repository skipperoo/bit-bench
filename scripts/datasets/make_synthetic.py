#!/usr/bin/env python3
"""Generate the small "synthetic" sample dataset (deterministic, no inputs).

It gives every BitBench install a standardized dataset to try the chunking
and aggregation tools on before the real recordings are exported::

    python3 scripts/datasets/make_synthetic.py            # -> datasets/synthetic/

Series (1,000,000 int64 values each by default):

* sine_noise   - 16-bit-range sine wave plus Gaussian noise (sensor-like)
* random_walk  - integer random walk (price-like, highly compressible deltas)
* sawtooth     - ramp that wraps every 4096 samples (counter-like)
* steps        - piecewise-constant levels (state-like, long runs)
* white_noise  - uniform 12-bit noise (incompressible baseline)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bitbench_bin import write_metadata, write_series  # noqa: E402


def generate(n: int, seed: int) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    t = np.arange(n)
    return {
        "sine_noise": np.rint(12000 * np.sin(2 * np.pi * t / 500) + rng.normal(0, 150, n)).astype(np.int64),
        "random_walk": (100_000 + np.cumsum(rng.integers(-25, 26, n))).astype(np.int64),
        "sawtooth": (t % 4096).astype(np.int64),
        "steps": np.repeat(rng.integers(0, 1000, n // 2000 + 1), 2000)[:n].astype(np.int64),
        "white_noise": rng.integers(0, 4096, n).astype(np.int64),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=Path("datasets"), help="datasets root (default: ./datasets)")
    parser.add_argument("--values", type=int, default=1_000_000, help="values per series")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    out_dir = args.out / "synthetic"
    for name, values in generate(args.values, args.seed).items():
        path = out_dir / f"{name}.bin"
        write_series(path, values, 0)
        print(f"wrote {path} ({values.size} values)")
    write_metadata(out_dir, "Deterministic synthetic signals for trying BitBench (seed %d)" % args.seed,
                   "scripts/datasets/make_synthetic.py")


if __name__ == "__main__":
    main()
