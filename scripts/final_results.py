#!/usr/bin/env python3

import argparse
import re
import sys
from pathlib import Path

import pandas as pd


def normalize_dataset_name(value: object) -> str:
    """Normalize dataset names coming from per-run benchmark logs.

    We want to keep the signal/channel identifiers (e.g. acc_x, ppg_ir, ecg)
    and only strip the trailing run index (e.g. ..._0, ..._79) if present.
    """
    dataset = str(value).strip()
    return re.sub(r"_\d+$", "", dataset)


def apply_memory_overrides(df: pd.DataFrame, results_csv_path: Path) -> pd.DataFrame:
    memory_csv_path = results_csv_path.with_name("memory.csv")
    if not memory_csv_path.is_file():
        return df

    memory_df = pd.read_csv(memory_csv_path, on_bad_lines="skip")
    memory_df.columns = memory_df.columns.str.strip()
    required = ["compressor", "dataset", "memory_usage"]
    if not set(required).issubset(set(memory_df.columns)):
        return df

    # Include optional breakdown columns if present
    extra_cols = [
        c
        for c in ["input_buffer", "compressor_internal", "internal_memory_ratio"]
        if c in memory_df.columns
    ]
    cols_to_keep = required + extra_cols

    memory_df = memory_df[cols_to_keep].copy()
    memory_df["compressor"] = (
        memory_df["compressor"].astype(str).str.strip().str.lower()
    )
    memory_df["dataset"] = memory_df["dataset"].astype(str).str.strip()

    for col in ["memory_usage"] + extra_cols:
        memory_df[col] = pd.to_numeric(memory_df[col], errors="coerce")

    memory_df = memory_df.dropna(subset=["memory_usage"])

    out = df.copy()
    out["signal_dataset"] = (
        out["dataset"].astype(str).str.replace(r"_\d+$", "", regex=True)
    )
    out["compressor_lower"] = out["compressor"].astype(str).str.lower()
    merged = out.merge(
        memory_df,
        left_on=["compressor_lower", "signal_dataset"],
        right_on=["compressor", "dataset"],
        how="left",
        suffixes=("", "_override"),
    )
    if "memory_usage_override" in merged.columns:
        merged["memory_usage"] = merged["memory_usage_override"].combine_first(
            merged.get("memory_usage")
        )
        for col in extra_cols:
            if f"{col}_override" in merged.columns:
                merged[col] = merged[f"{col}_override"]

        # Calculate ratio if missing but components are present
        if (
            "internal_memory_ratio" not in merged.columns
            or merged["internal_memory_ratio"].isna().all()
        ):
            if (
                "compressor_internal" in merged.columns
                and "input_buffer" in merged.columns
            ):
                merged["internal_memory_ratio"] = merged[
                    "compressor_internal"
                ] / merged["input_buffer"].replace(0, pd.NA)

    drop_cols = [
        "signal_dataset",
        "dataset_override",
        "memory_usage_override",
        "compressor_lower",
        "compressor_override",
    ]
    for col in extra_cols:
        drop_cols.append(f"{col}_override")

    return merged.drop(
        columns=drop_cols,
        errors="ignore",
    )


def extract_type_and_size(results_csv_path: Path) -> tuple[str, str]:
    parts = results_csv_path.parts
    data_type = None
    size = None

    for i, part in enumerate(parts):
        if part.startswith("size_"):
            size = part[len("size_") :] or part
            if i > 0:
                data_type = parts[i - 1]
            break

    if data_type is None:
        for part in parts:
            if part in {"std", "gap", "gap_shifted"}:
                data_type = part
                break

    if size is None:
        for part in parts:
            match = re.fullmatch(r"size[_-]?(.+)", part)
            if match:
                size = match.group(1)
                break

    if data_type is None or size is None:
        raise ValueError(f"Could not extract type/size from path: {results_csv_path}")

    return data_type, size


def _is_numeric_column_name(name: str) -> bool:
    try:
        float(name)
        return True
    except (ValueError, TypeError):
        return False


def build_intermediate(results_csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(results_csv_path, on_bad_lines="skip")
    df.columns = df.columns.str.strip()

    # Drop columns with purely numeric names (corrupted CSV headers)
    bad_cols = [c for c in df.columns if _is_numeric_column_name(c)]
    if bad_cols:
        df = df.drop(columns=bad_cols)

    required = {"compressor", "dataset"}
    missing = required - set(df.columns)
    if missing:
        missing_cols = ", ".join(sorted(missing))
        raise ValueError(
            f"Missing required column(s) in {results_csv_path}: {missing_cols}"
        )

    df["compressor"] = df["compressor"].astype(str).str.strip()
    df = apply_memory_overrides(df, results_csv_path)
    data_type, size = extract_type_and_size(results_csv_path)
    df["dataset"] = df["dataset"].map(normalize_dataset_name) + f"_{data_type}_{size}"
    numeric_cols = df.select_dtypes(include="number").columns.tolist()

    grouped = (
        df.groupby(["compressor", "dataset"], dropna=False)[numeric_cols]
        .mean()
        .reset_index()
    )
    grouped["source_results_csv"] = str(results_csv_path)

    ordered_columns = [
        "compressor",
        "dataset",
        *[
            c
            for c in grouped.columns
            if c not in {"compressor", "dataset", "source_results_csv"}
        ],
        "source_results_csv",
    ]
    grouped = grouped[ordered_columns]

    intermediate_path = results_csv_path.with_name("merged_by_compressor.csv")
    grouped.to_csv(intermediate_path, index=False)
    return grouped


def find_results_files(input_path: Path) -> tuple[Path, list[Path]]:
    if input_path.is_file():
        if input_path.name != "results.csv":
            raise ValueError(
                "Input file must be named results.csv or pass a directory."
            )
        return input_path.parent, [input_path]

    if not input_path.is_dir():
        raise ValueError(f"Input path does not exist: {input_path}")

    results_files = sorted(input_path.rglob("results.csv"))
    return input_path, results_files


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Recursively merge benchmark results.csv files into per-folder "
            "intermediates and a final aggregated file."
        )
    )
    parser.add_argument(
        "path",
        type=Path,
        help="Path to a root folder (or a single results.csv).",
    )
    args = parser.parse_args()

    root_dir, results_files = find_results_files(args.path.resolve())
    if not results_files:
        print(f"No results.csv files found under: {root_dir}", file=sys.stderr)
        return 1

    intermediate_dfs = [build_intermediate(path) for path in results_files]
    combined = pd.concat(intermediate_dfs, ignore_index=True)

    numeric_cols = combined.select_dtypes(include="number").columns.tolist()
    final_df = (
        combined.groupby(["compressor", "dataset"], dropna=False)[numeric_cols]
        .mean()
        .reset_index()
    )

    # Sort by dataset (parsed as dataset_type_size), then compressor
    final_df["dataset_base"] = final_df["dataset"].str.replace(r"_\d+$", "", regex=True)
    final_df["dataset_type"] = final_df["dataset"].str.extract(
        r"_(gap_shifted|std|gap)_", expand=False
    )
    final_df["dataset_size"] = final_df["dataset"].str.extract(r"_(\d+)$", expand=False)
    final_df["dataset_size"] = pd.to_numeric(final_df["dataset_size"], errors="coerce")

    final_df = final_df.sort_values(
        by=["dataset_base", "dataset_type", "dataset_size"], na_position="last"
    )
    # Note: we keep dataset_base, dataset_type, dataset_size for the per-compressor reports
    final_df = final_df.reset_index(drop=True)

    # Reorder to move metadata columns early
    cols = list(final_df.columns)
    metadata_cols = ["dataset_base", "dataset_type", "dataset_size"]
    for c in metadata_cols:
        if c in cols:
            cols.remove(c)
    final_df = final_df[["compressor", "dataset"] + metadata_cols + cols[2:]]

    final_output = root_dir / "final_results.csv"
    final_df.to_csv(final_output, index=False)
    print(f"Wrote final merged results to: {final_output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
