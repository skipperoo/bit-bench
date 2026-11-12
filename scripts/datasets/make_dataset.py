#!/usr/bin/env python3
"""Create a BitBench standardized dataset from your own data.

Each input column/array becomes one full-length series
``<out>/<dataset>/<series>.bin``. BitBench cuts the chunks itself (chunk size,
max chunks, std/gap/gap_shifted), so always export the *whole* recording.

Examples
--------
Every numeric column of a CSV (header row required), integers as-is::

    python3 scripts/datasets/make_dataset.py csv sensors.csv --dataset lab

Daily closing prices of several tickers, stored as cents (decimals=2)::

    python3 scripts/datasets/make_dataset.py csv prices.csv --dataset finance \\
        --columns NVDA,SPCX --decimals 2

A long-format CSV with one row per (ticker, value), one series per ticker::

    python3 scripts/datasets/make_dataset.py csv ticks.csv --dataset finance \\
        --group-by symbol --value close --decimals 2

NumPy arrays (one series per file, named after the file)::

    python3 scripts/datasets/make_dataset.py npy a.npy b.npy --dataset arrays

Plain text, one value per line::

    python3 scripts/datasets/make_dataset.py text counts.txt --dataset web

--decimals N multiplies every value by 10**N (rounded to an integer) and
stores N in the .bin header; without it, inputs must already be integers.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bitbench_bin import safe_name, scale_to_int, write_metadata, write_series  # noqa: E402


def to_series(values: np.ndarray, decimals: int, label: str) -> np.ndarray:
    values = np.asarray(values)
    if values.dtype.kind in "iu":
        return values.astype(np.int64) * (10 ** decimals) if decimals else values.astype(np.int64)
    if values.dtype.kind == "f":
        finite = values[np.isfinite(values)]
        if decimals == 0 and finite.size and not np.all(finite == np.trunc(finite)):
            raise SystemExit(f"{label}: has fractional values; pass --decimals N to keep N decimal digits")
        return scale_to_int(values, decimals)
    raise SystemExit(f"{label}: unsupported dtype {values.dtype}")


def drop_missing(values: np.ndarray, label: str, policy: str) -> np.ndarray:
    if values.dtype.kind != "f":
        return values
    missing = ~np.isfinite(values)
    if not missing.any():
        return values
    if policy == "error":
        raise SystemExit(f"{label}: {int(missing.sum())} missing values (use --missing drop|ffill)")
    if policy == "drop":
        return values[~missing]
    # forward fill; leading gaps are dropped
    series = np.asarray(values, dtype=np.float64).copy()
    idx = np.where(~missing, np.arange(series.size), 0)
    np.maximum.accumulate(idx, out=idx)
    filled = series[idx]
    first = np.argmax(~missing)
    return filled[first:]


def emit(out_dir: Path, name: str, values: np.ndarray, args: argparse.Namespace) -> None:
    values = drop_missing(values, name, args.missing)
    series = to_series(values, args.decimals, name)
    path = out_dir / f"{safe_name(name)}.bin"
    if path.exists() and not args.force:
        raise SystemExit(f"{path} exists (use --force to overwrite)")
    n = write_series(path, series, args.decimals)
    print(f"wrote {path} ({n} values, decimals={args.decimals})")


def cmd_csv(args: argparse.Namespace) -> list[tuple[str, np.ndarray]]:
    import pandas as pd

    df = pd.read_csv(args.input[0], sep=args.sep)
    if args.group_by:
        if not args.value:
            raise SystemExit("--group-by needs --value <column>")
        if args.sort_by:
            df = df.sort_values(args.sort_by, kind="stable")
        return [(str(key), group[args.value].to_numpy()) for key, group in df.groupby(args.group_by, sort=True)]

    columns = [c.strip() for c in args.columns.split(",")] if args.columns else list(df.columns)
    out = []
    for col in columns:
        if col not in df.columns:
            raise SystemExit(f"column {col!r} not found; available: {', '.join(map(str, df.columns))}")
        raw = df[col]
        if pd.api.types.is_bool_dtype(raw):
            series = raw.astype(np.int64)
        elif pd.api.types.is_numeric_dtype(raw):
            series = raw
        else:
            # Text column: numeric only if every non-empty cell parses.
            series = pd.to_numeric(raw, errors="coerce")
            if series.notna().sum() < raw.notna().sum() or series.isna().all():
                if args.columns is None:
                    print(f"skipping non-numeric column {col!r}")
                    continue
                raise SystemExit(f"column {col!r} contains non-numeric values")
        out.append((str(col), series.to_numpy(dtype=np.float64) if series.dtype.kind == "f" else series.to_numpy()))
    return out


def cmd_npy(args: argparse.Namespace) -> list[tuple[str, np.ndarray]]:
    out = []
    for p in args.input:
        arr = np.load(p)
        if arr.ndim != 1:
            raise SystemExit(f"{p}: expected a 1-D array, got shape {arr.shape}")
        out.append((Path(p).stem, arr))
    return out


def cmd_text(args: argparse.Namespace) -> list[tuple[str, np.ndarray]]:
    out = []
    for p in args.input:
        arr = np.loadtxt(p, dtype=np.float64 if args.decimals else np.int64, ndmin=1)
        out.append((Path(p).stem, arr))
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("format", choices=["csv", "npy", "text"])
    parser.add_argument("input", nargs="+", help="input file(s)")
    parser.add_argument("--dataset", required=True, help="dataset name (directory under --out)")
    parser.add_argument("--out", default="datasets", help="datasets root (default: ./datasets)")
    parser.add_argument("--decimals", type=int, default=0, help="keep N decimal digits of float inputs")
    parser.add_argument("--columns", help="CSV: comma-separated columns to export (default: all numeric)")
    parser.add_argument("--sep", default=",", help="CSV separator (default: ,)")
    parser.add_argument("--group-by", help="CSV long format: one series per distinct value of this column")
    parser.add_argument("--value", help="CSV long format: column holding the values")
    parser.add_argument("--sort-by", help="CSV long format: sort rows by this column first (e.g. a timestamp)")
    parser.add_argument("--missing", choices=["error", "drop", "ffill"], default="error",
                        help="how to handle NaN/empty cells (default: error)")
    parser.add_argument("--description", help="dataset.yaml description")
    parser.add_argument("--source", help="dataset.yaml source / citation")
    parser.add_argument("--force", action="store_true", help="overwrite existing series")
    args = parser.parse_args()

    if not 0 <= args.decimals <= 18:
        raise SystemExit("--decimals must be between 0 and 18")
    out_dir = Path(args.out) / safe_name(args.dataset)
    columns = {"csv": cmd_csv, "npy": cmd_npy, "text": cmd_text}[args.format](args)
    if not columns:
        raise SystemExit("nothing to export")
    for name, values in columns:
        emit(out_dir, name, np.asarray(values), args)
    if args.description or args.source:
        write_metadata(out_dir, args.description or args.dataset, args.source)
    print(f"dataset ready: {out_dir}")


if __name__ == "__main__":
    main()
