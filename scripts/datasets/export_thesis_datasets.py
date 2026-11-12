#!/usr/bin/env python3
"""Export the thesis datasets (WildPPG, PAMAP2) as BitBench full series.

This is the full-recording counterpart of ``convert_ds_full.py`` from the
gef-experiments repository: it applies the same ADC projections but writes
each signal *whole* (``datasets/<dataset>/<series>.bin``) instead of
pre-cut ``datasets/<std|gap|gap_shifted>/size_<N>/`` chunks. BitBench cuts the
chunks at run time:

* ``size_<B>`` folders correspond to a chunk size of B/2 samples (the thesis
  sizes count bytes of the original 16-bit stream): 512->256, 1536->768,
  8192->4096, 16384->8192, 32768->16384, 65536->32768, 1572864->786432;
* "max chunks per series" = 10 reproduces ``MAX_CHUNKS_PER_SIGNAL``
  (evenly spaced, numpy rounding);
* transform std/gap match the thesis variants. gap_shifted is the corrected
  version (every value >= 0), so it intentionally differs from the thesis
  files.

WildPPG chunks are byte-identical to the thesis std/gap files. PAMAP2
chunks may differ for small sizes: the thesis cut each NaN-free run
separately, while a single full series concatenates the valid runs.

Usage::

    python3 scripts/datasets/export_thesis_datasets.py wildppg /path/to/WildPPG.mat
    python3 scripts/datasets/export_thesis_datasets.py pamap2 /path/to/PAMAP2_Dataset/Protocol
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bitbench_bin import write_metadata, write_series  # noqa: E402

# --- WildPPG (identical to convert_ds_full.py) ------------------------------
PPG_ADC_BITS = 19
PPG_ADC_MAX = (1 << PPG_ADC_BITS) - 1
ACC_ADC_BITS = 10
ACC_ADC_MIN = -(1 << (ACC_ADC_BITS - 1))
ACC_ADC_MAX = (1 << (ACC_ADC_BITS - 1)) - 1
ACC_LSB_G = 0.008
WILDPPG_DECIMALS = 1
WILDPPG_SIGNALS = {
    "sternum": ["ecg"],
    "wrist": ["ppg_g", "ppg_r", "ppg_ir", "acc_x", "acc_y", "acc_z"],
}

# --- PAMAP2 (identical to convert_ds_full.py) -------------------------------
STANDARD_GRAVITY = 9.80665
PAMAP2_ACC_BITS = 13
PAMAP2_ACC_MIN = -(1 << (PAMAP2_ACC_BITS - 1))
PAMAP2_ACC_MAX = (1 << (PAMAP2_ACC_BITS - 1)) - 1
PAMAP2_ACC_LSB_G = 16.0 / (1 << (PAMAP2_ACC_BITS - 1))
PAMAP2_GYRO_BITS = 13
PAMAP2_GYRO_MIN = -(1 << (PAMAP2_GYRO_BITS - 1))
PAMAP2_GYRO_MAX = (1 << (PAMAP2_GYRO_BITS - 1)) - 1
PAMAP2_GYRO_LSB_DPS = (2.0 * 2000.0) / (1 << PAMAP2_GYRO_BITS)
PAMAP2_DECIMALS = 1
PAMAP2_HAND_BASE = 4  # hand IMU block (exported as "wrist")
PAMAP2_AXES = ("x", "y", "z")


def project_wildppg(values, signal_name: str) -> np.ndarray:
    values = np.asarray(values, dtype=np.float64)
    if signal_name.startswith("ppg_"):
        return np.clip(np.rint(values * (1 << PPG_ADC_BITS)), 0, PPG_ADC_MAX).astype(np.int64)
    if signal_name.startswith("acc_"):
        return np.clip(np.rint(values / ACC_LSB_G), ACC_ADC_MIN, ACC_ADC_MAX).astype(np.int64)
    return np.asarray(values, dtype=np.int64)  # ECG: raw 18-bit codes


def export_wildppg(mat_path: Path, out_root: Path) -> None:
    import scipy.io as sio

    mat = sio.loadmat(str(mat_path))
    out_dir = out_root / "wildppg"
    for location, signals in WILDPPG_SIGNALS.items():
        located = mat[location][0, 0]
        for signal in signals:
            series = located[signal].flatten()
            raw = project_wildppg(series[0][2][0], signal)
            path = out_dir / f"{location}_{signal}.bin"
            n = write_series(path, raw, WILDPPG_DECIMALS)
            print(f"wrote {path} ({n} values, fs={series[0][0][0, 0]} Hz)")
    write_metadata(
        out_dir,
        "WildPPG: wrist PPG (19-bit ADC codes) and accelerometer (10-bit), sternum ECG (18-bit), full recordings",
        "Meier et al., WildPPG: A Real-World PPG Dataset of Long Continuous Recordings (NeurIPS 2024)",
    )


def export_pamap2(path: Path, out_root: Path) -> None:
    import pandas as pd

    files = [path] if path.is_file() else sorted(path.rglob("*.dat"))
    if not files:
        raise SystemExit(f"no PAMAP2 .dat files under {path}")

    specs = (
        ("acc", range(0, 3), lambda v: np.clip(np.rint((v / STANDARD_GRAVITY) / PAMAP2_ACC_LSB_G),
                                              PAMAP2_ACC_MIN, PAMAP2_ACC_MAX)),
        ("gyro", range(6, 9), lambda v: np.clip(np.rint(np.degrees(v) / PAMAP2_GYRO_LSB_DPS),
                                               PAMAP2_GYRO_MIN, PAMAP2_GYRO_MAX)),
    )
    usecols = sorted(PAMAP2_HAND_BASE + o for _, offsets, _ in specs for o in offsets)
    runs = {(s, a): [] for s, _, _ in specs for a in PAMAP2_AXES}

    for file_path in files:
        df = pd.read_csv(file_path, sep=r"\s+", header=None, usecols=usecols, na_values="NaN", low_memory=False)
        for signal, offsets, project in specs:
            block = df.iloc[:, [usecols.index(PAMAP2_HAND_BASE + o) for o in offsets]].to_numpy(dtype=np.float64)
            for j, axis in enumerate(PAMAP2_AXES):
                values = block[:, j]
                valid = np.isfinite(values)
                edges = np.flatnonzero(np.diff(np.r_[False, valid, False].astype(np.int8)))
                for start, end in zip(edges[::2], edges[1::2]):
                    runs[(signal, axis)].append(project(values[start:end]).astype(np.int64))
        print(f"loaded {file_path} ({len(df):,} rows)")

    out_dir = out_root / "pamap2"
    for (signal, axis), parts in runs.items():
        if not parts:
            continue
        path = out_dir / f"wrist_{signal}_{axis}.bin"
        n = write_series(path, np.concatenate(parts), PAMAP2_DECIMALS)
        print(f"wrote {path} ({n} values from {len(parts)} NaN-free runs)")
    write_metadata(
        out_dir,
        "PAMAP2 hand IMU: 13-bit accelerometer (+/-16 g) and gyroscope (+/-2000 dps) codes, valid runs concatenated",
        "Reiss & Stricker, Introducing a New Benchmarked Dataset for Activity Monitoring (ISWC 2012)",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dataset", choices=["wildppg", "pamap2"])
    parser.add_argument("input", type=Path, help="WildPPG.mat, or a PAMAP2 .dat file / directory")
    parser.add_argument("--out", type=Path, default=Path("datasets"), help="datasets root (default: ./datasets)")
    args = parser.parse_args()
    if not args.input.exists():
        raise SystemExit(f"{args.input} does not exist")
    if args.dataset == "wildppg":
        export_wildppg(args.input, args.out)
    else:
        export_pamap2(args.input, args.out)


if __name__ == "__main__":
    main()
