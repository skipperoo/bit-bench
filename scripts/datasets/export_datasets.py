#!/usr/bin/env python3
"""
Usage:
    python3 scripts/datasets/export_datasets.py wildppg /path/to/WildPPG.mat
    python3 scripts/datasets/export_datasets.py pamap2 /path/to/PAMAP2_Dataset/Protocol
    python3 scripts/datasets/export_datasets.py wildppg WildPPG.mat --all-signals --exclude '*_acc_*'
"""

from __future__ import annotations

import argparse
import fnmatch
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
WILDPPG_SIGNALS = {
    "sternum": ["ecg"],
    "wrist": ["ppg_g", "ppg_r", "ppg_ir", "acc_x", "acc_y", "acc_z"],
}
# --all-signals: the slow (0.5 Hz) environment channels, projected to 19 bits
# over a fixed power-of-two range so every site shares one scale.
WILDPPG_ALTITUDE_RANGE_M = 4096.0
WILDPPG_TEMPERATURE_RANGE_C = 64.0

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
PAMAP2_HAND_BASE = 4  # hand IMU block (exported as "wrist")
PAMAP2_AXES = ("x", "y", "z")
# --all-signals: every IMU block (17 columns each, from column index 3) and the
# heart rate (column index 2).
PAMAP2_IMUS = {"wrist": 3, "chest": 20, "ankle": 37}
PAMAP2_HEART_RATE = 2
PAMAP2_ACC6_LSB_G = 12.0 / (1 << PAMAP2_ACC_BITS)
PAMAP2_MAG_LSB_UT = 0.1


def project_wildppg(values, signal_name: str) -> np.ndarray:
    values = np.asarray(values, dtype=np.float64)
    if signal_name.startswith("ppg_"):
        return np.clip(np.rint(values * (1 << PPG_ADC_BITS)), 0, PPG_ADC_MAX).astype(
            np.int64
        )
    if signal_name.startswith("acc_"):
        return np.clip(np.rint(values / ACC_LSB_G), ACC_ADC_MIN, ACC_ADC_MAX).astype(
            np.int64
        )
    if signal_name == "altitude":
        return np.clip(
            np.rint(values * (1 << PPG_ADC_BITS) / WILDPPG_ALTITUDE_RANGE_M),
            0,
            PPG_ADC_MAX,
        ).astype(np.int64)
    if signal_name == "temperature":
        return np.clip(
            np.rint(values * (1 << PPG_ADC_BITS) / WILDPPG_TEMPERATURE_RANGE_C),
            0,
            PPG_ADC_MAX,
        ).astype(np.int64)
    if signal_name == "ecg":
        if not np.array_equal(values, np.rint(values)):
            raise SystemExit("WildPPG ECG is expected to hold integer ADC codes")
        return values.astype(np.int64)  # raw 18-bit codes
    raise SystemExit(f"no projection for WildPPG signal {signal_name!r}")


def excluded(name: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatchcase(name, p) for p in patterns)


def export_wildppg(
    mat_path: Path, out_root: Path, decimals: int, all_signals: bool, exclude: list[str]
) -> None:
    import scipy.io as sio

    mat = sio.loadmat(str(mat_path))
    out_dir = out_root / "wildppg"
    if all_signals:
        selection = {
            loc: list(mat[loc].dtype.names)
            for loc in ("sternum", "head", "ankle", "wrist")
            if loc in mat
        }
    else:
        selection = WILDPPG_SIGNALS
    written = 0
    kinds: set[str] = set()
    for location, signals in selection.items():
        located = mat[location][0, 0]
        for signal in signals:
            name = f"{location}_{signal}"
            if excluded(name, exclude):
                continue
            series = located[signal].flatten()
            raw = project_wildppg(series[0][2][0], signal)
            path = out_dir / f"{name}.bin"
            n = write_series(path, raw, decimals)
            written += 1
            kinds.add(signal.split("_")[0])
            print(
                f"wrote {path} ({n} values, fs={series[0][0][0, 0]} Hz, codes {raw.min()}..{raw.max()})"
            )
    if not written:
        raise SystemExit("no WildPPG series left after --exclude")
    if all_signals:
        parts = {
            "ppg": "PPG green/red/IR as 19-bit codes",
            "ecg": "sternum ECG as raw 18-bit codes",
            "acc": "accelerometer as 10-bit codes",
            "altitude": "altitude projected to 19 bits (1/128 m)",
            "temperature": "device temperature projected to 19 bits (1/8192 degC)",
        }
        description = (
            "WildPPG, one participant, full recordings of every site: "
            + ", ".join(text for kind, text in parts.items() if kind in kinds)
        )
    else:
        description = "WildPPG: wrist PPG (19-bit ADC codes) and accelerometer (10-bit), sternum ECG (18-bit), full recordings"
    write_metadata(
        out_dir,
        description,
        "Meier et al., WildPPG: A Real-World PPG Dataset of Long Continuous Recordings (NeurIPS 2024)",
    )


def _valid_runs(values: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) of the NaN-free runs of a column."""
    valid = np.isfinite(values)
    edges = np.flatnonzero(np.diff(np.r_[False, valid, False].astype(np.int8)))
    return list(zip(edges[::2], edges[1::2]))


def export_pamap2_all(
    files: list[Path], out_dir: Path, decimals: int, exclude: list[str]
) -> None:
    """Every IMU signal of every block plus the heart rate (--all-signals)."""
    import pandas as pd

    def acc(lsb_g: float):
        return lambda v: np.clip(
            np.rint((v / STANDARD_GRAVITY) / lsb_g), PAMAP2_ACC_MIN, PAMAP2_ACC_MAX
        )

    # (series suffix, offset inside the IMU block, projection)
    block = [("temperature", 0, lambda v: np.rint(v * 16))]
    block += [
        (f"acc_{a}", 1 + j, acc(PAMAP2_ACC_LSB_G)) for j, a in enumerate(PAMAP2_AXES)
    ]
    block += [
        (f"acc6_{a}", 4 + j, acc(PAMAP2_ACC6_LSB_G)) for j, a in enumerate(PAMAP2_AXES)
    ]
    block += [
        (
            f"gyro_{a}",
            7 + j,
            lambda v: np.clip(
                np.rint(np.degrees(v) / PAMAP2_GYRO_LSB_DPS),
                PAMAP2_GYRO_MIN,
                PAMAP2_GYRO_MAX,
            ),
        )
        for j, a in enumerate(PAMAP2_AXES)
    ]
    block += [
        (f"mag_{a}", 10 + j, lambda v: np.rint(v / PAMAP2_MAG_LSB_UT))
        for j, a in enumerate(PAMAP2_AXES)
    ]
    specs = [("heart_rate", PAMAP2_HEART_RATE, np.rint)]
    specs += [
        (f"{imu}_{suffix}", base + offset, project)
        for imu, base in PAMAP2_IMUS.items()
        for suffix, offset, project in block
    ]
    specs = [s for s in specs if not excluded(s[0], exclude)]
    if not specs:
        raise SystemExit("no PAMAP2 series left after --exclude")

    usecols = sorted({col for _, col, _ in specs})
    runs: dict[str, list[np.ndarray]] = {name: [] for name, _, _ in specs}
    clipped: dict[str, int] = {name: 0 for name, _, _ in specs}
    for file_path in files:
        df = pd.read_csv(
            file_path,
            sep=r"\s+",
            header=None,
            usecols=usecols,
            na_values="NaN",
            low_memory=False,
        )
        for name, col, project in specs:
            values = df[col].to_numpy(dtype=np.float64)
            for start, end in _valid_runs(values):
                part = values[start:end]
                codes = project(part).astype(np.int64)
                if "acc" in name or "gyro" in name:
                    clipped[name] += int(
                        np.count_nonzero(
                            (codes == PAMAP2_ACC_MIN) | (codes == PAMAP2_ACC_MAX)
                        )
                    )
                runs[name].append(codes)
        print(f"loaded {file_path} ({len(df):,} rows)")

    kinds: set[str] = set()
    for name, parts in runs.items():
        if not parts:
            continue
        kinds.add(
            "heart_rate"
            if name == "heart_rate"
            else name.split("_", 1)[1].split("_")[0]
        )
        data = np.concatenate(parts)
        path = out_dir / f"{name}.bin"
        n = write_series(path, data, decimals)
        note = f", {clipped[name]} at the 13-bit limit" if clipped[name] else ""
        print(
            f"wrote {path} ({n} values from {len(parts)} NaN-free runs, codes {data.min()}..{data.max()}{note})"
        )
    parts = {
        "temperature": "temperature (1/16 degC)",
        "acc": "+/-16 g accelerometer (13-bit codes)",
        "acc6": "+/-6 g accelerometer (13-bit codes)",
        "gyro": "gyroscope (+/-2000 dps, 13-bit codes)",
        "mag": "magnetometer (0.1 uT)",
        "heart_rate": "heart rate (bpm)",
    }
    write_metadata(
        out_dir,
        "PAMAP2 IMUs (hand as wrist, chest, ankle), NaN-free runs concatenated: "
        + ", ".join(text for kind, text in parts.items() if kind in kinds),
        "Reiss & Stricker, Introducing a New Benchmarked Dataset for Activity Monitoring (ISWC 2012)",
    )


def export_pamap2(
    path: Path, out_root: Path, decimals: int, all_signals: bool, exclude: list[str]
) -> None:
    import pandas as pd

    files = [path] if path.is_file() else sorted(path.rglob("*.dat"))
    if not files:
        raise SystemExit(f"no PAMAP2 .dat files under {path}")
    if all_signals:
        export_pamap2_all(files, out_root / "pamap2", decimals, exclude)
        return

    specs = (
        (
            "acc",
            range(0, 3),
            lambda v: np.clip(
                np.rint((v / STANDARD_GRAVITY) / PAMAP2_ACC_LSB_G),
                PAMAP2_ACC_MIN,
                PAMAP2_ACC_MAX,
            ),
        ),
        (
            "gyro",
            range(6, 9),
            lambda v: np.clip(
                np.rint(np.degrees(v) / PAMAP2_GYRO_LSB_DPS),
                PAMAP2_GYRO_MIN,
                PAMAP2_GYRO_MAX,
            ),
        ),
    )
    usecols = sorted(PAMAP2_HAND_BASE + o for _, offsets, _ in specs for o in offsets)
    runs = {(s, a): [] for s, _, _ in specs for a in PAMAP2_AXES}

    for file_path in files:
        df = pd.read_csv(
            file_path,
            sep=r"\s+",
            header=None,
            usecols=usecols,
            na_values="NaN",
            low_memory=False,
        )
        for signal, offsets, project in specs:
            block = df.iloc[
                :, [usecols.index(PAMAP2_HAND_BASE + o) for o in offsets]
            ].to_numpy(dtype=np.float64)
            for j, axis in enumerate(PAMAP2_AXES):
                values = block[:, j]
                valid = np.isfinite(values)
                edges = np.flatnonzero(
                    np.diff(np.r_[False, valid, False].astype(np.int8))
                )
                for start, end in zip(edges[::2], edges[1::2]):
                    runs[(signal, axis)].append(
                        project(values[start:end]).astype(np.int64)
                    )
        print(f"loaded {file_path} ({len(df):,} rows)")

    out_dir = out_root / "pamap2"
    for (signal, axis), parts in runs.items():
        if not parts or excluded(f"wrist_{signal}_{axis}", exclude):
            continue
        path = out_dir / f"wrist_{signal}_{axis}.bin"
        n = write_series(path, np.concatenate(parts), decimals)
        print(f"wrote {path} ({n} values from {len(parts)} NaN-free runs)")
    write_metadata(
        out_dir,
        "PAMAP2 hand IMU: 13-bit accelerometer (+/-16 g) and gyroscope (+/-2000 dps) codes, valid runs concatenated",
        "Reiss & Stricker, Introducing a New Benchmarked Dataset for Activity Monitoring (ISWC 2012)",
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("dataset", choices=["wildppg", "pamap2"])
    parser.add_argument(
        "input", type=Path, help="WildPPG.mat, or a PAMAP2 .dat file / directory"
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("datasets"),
        help="datasets root (default: ./datasets)",
    )
    parser.add_argument(
        "--decimals",
        type=int,
        default=0,
        help="decimals written in the .bin header (default 0: the values are integer ADC codes). ",
    )
    parser.add_argument(
        "--all-signals",
        action="store_true",
        help="write every signal of every site/IMU instead of the thesis selection",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="PATTERN",
        help="skip series whose name matches this shell pattern (repeatable), e.g. '*_acc_*'",
    )
    args = parser.parse_args()
    if not 0 <= args.decimals <= 18:
        raise SystemExit("--decimals must be between 0 and 18")
    if not args.input.exists():
        raise SystemExit(f"{args.input} does not exist")
    if args.dataset == "wildppg":
        export_wildppg(
            args.input, args.out, args.decimals, args.all_signals, args.exclude
        )
    else:
        export_pamap2(
            args.input, args.out, args.decimals, args.all_signals, args.exclude
        )


if __name__ == "__main__":
    main()
