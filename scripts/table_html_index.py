#!/usr/bin/env python3

from __future__ import annotations

import argparse
import html
from pathlib import Path

import numpy as np
import pandas as pd


GENERAL_PURPOSE_KEYS = {"xz", "brotli", "zstd", "lz4", "snappy"}

GEF_ORDER = [
    "rle_gef",
    "u_gef_approximate",
    "u_gef_optimal",
    "b_gef_approximate",
    "b_gef_optimal",
    "b_star_gef_approximate",
    "b_star_gef_optimal",
]

NAME_MAPPING_FULL = {
    "rle_gef": "RLE-GEF",
    "u_gef_approximate": "UGEF (approx)",
    "u_gef_optimal": "UGEF*",
    "b_gef_approximate": "BGEF (approx)",
    "b_gef_optimal": "BGEF*",
    "b_star_gef_approximate": "B*-GEF (approx)",
    "b_star_gef_optimal": "B*-GEF*",
    "neats": "NeaTS",
    "dac": "DAC",
    "gorilla": "Gorilla",
    "chimp": "Chimp",
    "chimp128": "Chimp128",
    "lz4": "Lz4",
    "zstd": "Zstd",
    "brotli": "Brotli",
    "snappy": "Snappy",
    "xz": "Xz",
    "leco": "LeCo",
    "alp": "ALP",
    "elf": "ELF",
    "tsxor": "TSXor",
}

NAME_MAPPING_SIMPLE = {
    "u_gef_optimal": "UGEF",
    "b_gef_optimal": "BGEF",
    "b_star_gef_optimal": "B*-GEF",
    "rle_gef": "RLE-GEF",
}

DEFAULT_DATASET_ORDER = [
    "IT",
    "US",
    "ECG",
    "WD",
    "AP",
    "UK",
    "GE",
    "LON",
    "LAT",
    "DP",
    "CT",
    "DU",
    "BT",
    "BW",
    "BM",
    "BP",
]


def get_display_name(raw_name: str, simplify: bool = False) -> str:
    key = raw_name.strip()
    lower_key = key.lower()
    if simplify and lower_key in NAME_MAPPING_SIMPLE:
        return NAME_MAPPING_SIMPLE[lower_key]
    if key in NAME_MAPPING_FULL:
        return NAME_MAPPING_FULL[key]
    if lower_key in NAME_MAPPING_FULL:
        return NAME_MAPPING_FULL[lower_key]
    return key


def format_value(value: float, conversion_factor: float = 1.0) -> str:
    if pd.isna(value):
        return "-"
    return f"{value / conversion_factor:.2f}"


def get_best_variant(base: str, available: set[str]) -> str | None:
    optimal = f"{base}_optimal"
    approximate = f"{base}_approximate"
    if optimal in available:
        return optimal
    if approximate in available:
        return approximate
    return None


def build_dataset_order(df: pd.DataFrame, dataset_arg: str | None) -> list[str]:
    available_datasets = set(df["dataset"].unique())
    target_order = [d.strip() for d in dataset_arg.split(",")] if dataset_arg else DEFAULT_DATASET_ORDER
    final_dataset_order: list[str] = []

    for ds in target_order:
        if ds in available_datasets:
            final_dataset_order.append(ds)
        elif f"{ds}.bin" in available_datasets:
            final_dataset_order.append(f"{ds}.bin")

    remaining = sorted([d for d in available_datasets if d not in final_dataset_order])
    final_dataset_order.extend(remaining)
    return final_dataset_order


def build_column_groups(df: pd.DataFrame, compressors_arg: str | None) -> tuple[list[tuple[str, list[str]]], list[tuple[str, list[str]]]]:
    available = set(df["compressor"].unique())

    gef_list_all = [c for c in GEF_ORDER if c in available]
    gef_list_optimal: list[str] = []
    if "rle_gef" in available:
        gef_list_optimal.append("rle_gef")
    for base in ["u_gef", "b_gef", "b_star_gef"]:
        variant = get_best_variant(base, available)
        if variant:
            gef_list_optimal.append(variant)

    if compressors_arg:
        requested = [c.strip() for c in compressors_arg.split(",")]
        others_list = [c for c in requested if c in available]
    else:
        others_list = [c for c in available if c not in GEF_ORDER and c != "b_star_gef_optimal"]

    general_list = sorted([c for c in others_list if c.lower() in GENERAL_PURPOSE_KEYS])
    special_list = sorted([c for c in others_list if c.lower() not in GENERAL_PURPOSE_KEYS])

    all_groups = [
        ("General-purpose compressors", general_list),
        ("Special-purpose compressors", special_list),
        ("GEF variants", gef_list_all),
    ]
    optimal_groups = [
        ("General-purpose compressors", general_list),
        ("Special-purpose compressors", special_list),
        ("GEF variants", gef_list_optimal),
    ]
    return all_groups, optimal_groups


def build_data_map(
    df: pd.DataFrame,
    metric_col: str,
    datasets: list[str],
    all_compressors: list[str],
) -> dict[str, dict[str, float]]:
    data_map: dict[str, dict[str, float]] = {}
    for ds in datasets:
        ds_clean = ds.replace(".bin", "").strip()
        lookup_name = ds
        if ds not in df["dataset"].values and f"{ds}.bin" in df["dataset"].values:
            lookup_name = f"{ds}.bin"

        data_map[ds_clean] = {}
        for comp in all_compressors:
            subset = df[(df["dataset"] == lookup_name) & (df["compressor"] == comp)]
            data_map[ds_clean][comp] = subset[metric_col].mean() if not subset.empty else np.nan
    return data_map


def rank_map(values: list[float], is_min_best: bool) -> dict[float, int]:
    valid_values = [v for v in values if not pd.isna(v)]
    sorted_values = sorted(valid_values, reverse=not is_min_best)
    ranking: dict[float, int] = {}
    for idx, value in enumerate(sorted_values):
        if value not in ranking:
            ranking[value] = idx
    return ranking


def render_metric_table(
    df: pd.DataFrame,
    title: str,
    metric_col: str,
    col_groups: list[tuple[str, list[str]]],
    datasets: list[str],
    is_min_best: bool,
    conversion_factor: float = 1.0,
    simplify_headers: bool = False,
    footer_note: str | None = None,
) -> str:
    active_groups = [(name, cols) for name, cols in col_groups if cols]
    all_compressors = [comp for _, cols in active_groups for comp in cols]
    if not all_compressors:
        return f"<details class='accordion'><summary>{html.escape(title)}</summary><p class='empty'>No compressors available for this table.</p></details>"

    data = build_data_map(df, metric_col, datasets, all_compressors)

    group_headers = "".join(
        f"<th colspan='{len(cols)}'>{html.escape(group_name)}</th>" for group_name, cols in active_groups
    )
    col_headers = "".join(
        f"<th>{html.escape(get_display_name(comp, simplify=simplify_headers))}</th>"
        for _, cols in active_groups
        for comp in cols
    )

    rows_html: list[str] = []
    for ds in datasets:
        ds_clean = ds.replace(".bin", "").strip()
        if ds_clean not in data:
            continue

        row_values_all = [data[ds_clean][comp] for comp in all_compressors if not pd.isna(data[ds_clean][comp])]
        ranking = rank_map(row_values_all, is_min_best)

        value_cells: list[str] = []
        for _, cols in active_groups:
            for comp in cols:
                value = data[ds_clean][comp]
                display = format_value(value, conversion_factor)
                if pd.isna(value):
                    value_cells.append("<td>-</td>")
                    continue

                rank = ranking.get(value, 99)
                css_class = ""
                if rank == 0:
                    css_class = " class='rank-1'"
                elif rank == 1:
                    css_class = " class='rank-2'"
                elif rank == 2:
                    css_class = " class='rank-3'"
                value_cells.append(f"<td{css_class}>{html.escape(display)}</td>")

        rows_html.append(
            f"<tr><th>{html.escape(ds_clean)}</th>{''.join(value_cells)}</tr>"
        )

    footer_html = f"<p class='footnote'>{html.escape(footer_note)}</p>" if footer_note else ""
    return f"""
<details class="accordion">
  <summary>{html.escape(title)}</summary>
  <div class="table-panel">
    <table>
      <thead>
        <tr><th rowspan="2">Dataset</th>{group_headers}</tr>
        <tr>{col_headers}</tr>
      </thead>
      <tbody>
        {''.join(rows_html)}
      </tbody>
    </table>
    {footer_html}
  </div>
</details>
""".strip()


def build_html_page(table_sections: list[str]) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Compression Table Index</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 24px; background: #fafafa; }}
    h1 {{ margin-bottom: 18px; }}
    .accordion {{
      border: 1px solid #ddd;
      border-radius: 8px;
      margin-bottom: 12px;
      background: #fff;
    }}
    summary {{
      cursor: pointer;
      padding: 12px 14px;
      font-weight: 600;
      outline: none;
    }}
    .table-panel {{
      padding: 0 14px 14px 14px;
      overflow-x: auto;
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
      white-space: nowrap;
      font-size: 0.92rem;
    }}
    th, td {{
      border: 1px solid #ddd;
      padding: 6px 8px;
      text-align: right;
    }}
    thead th {{
      background: #f3f3f3;
      text-align: center;
    }}
    tbody th {{
      background: #f9f9f9;
      text-align: left;
      position: sticky;
      left: 0;
    }}
    .rank-1 {{ font-weight: 700; }}
    .rank-2 {{ text-decoration: underline; }}
    .rank-3 {{ font-style: italic; }}
    .footnote {{
      margin: 8px 0 0 0;
      color: #555;
      font-size: 0.9rem;
    }}
    .empty {{ color: #555; padding: 14px; }}
  </style>
</head>
<body>
  <h1>Compression table index</h1>
  {"".join(table_sections)}
</body>
</html>
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate HTML tables from benchmark CSV output.")
    parser.add_argument("csv_file", type=str, help="Path to input CSV file")
    parser.add_argument("output_dir", nargs="?", default="tables", help="Output directory")
    parser.add_argument("--compressors", type=str, help="Comma-separated list of compressors (excluding GEF).")
    parser.add_argument("--datasets", type=str, help="Comma-separated list of datasets to define row order.")
    args = parser.parse_args()

    csv_path = Path(args.csv_file)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not csv_path.exists():
        raise SystemExit(f"Error: CSV file not found: {csv_path}")

    df = pd.read_csv(csv_path)
    df.columns = df.columns.str.strip()
    df["dataset"] = df["dataset"].str.strip()
    df["compressor"] = df["compressor"].str.strip()

    datasets = build_dataset_order(df, args.datasets)
    column_groups_all, column_groups_opt = build_column_groups(df, args.compressors)

    split_point_note = "With C(approx) and C*, we denote the GEF variant C that uses either its approximated or optimal split point, respectively."
    sections = [
        render_metric_table(
            df=df,
            title="Compression Ratio (%)",
            metric_col="compression_ratio",
            col_groups=column_groups_all,
            datasets=datasets,
            is_min_best=True,
            footer_note=split_point_note,
        ),
        render_metric_table(
            df=df,
            title="Compression Throughput (MB/s)",
            metric_col="compression_throughput_mbs",
            col_groups=column_groups_all,
            datasets=datasets,
            is_min_best=False,
            footer_note=split_point_note,
        ),
        render_metric_table(
            df=df,
            title="Decompression Throughput (GB/s)",
            metric_col="decompression_throughput_mbs",
            col_groups=column_groups_opt,
            datasets=datasets,
            is_min_best=False,
            conversion_factor=1024.0,
            simplify_headers=True,
        ),
        render_metric_table(
            df=df,
            title="Random Access Throughput (MB/s)",
            metric_col="random_access_mbs",
            col_groups=column_groups_opt,
            datasets=datasets,
            is_min_best=False,
            simplify_headers=True,
        ),
    ]

    if "original_size" in df.columns:
        sections.append(
            render_metric_table(
                df=df,
                title="Input Size (bytes)",
                metric_col="original_size",
                col_groups=column_groups_opt,
                datasets=datasets,
                is_min_best=True,
                simplify_headers=True,
            )
        )

    if "memory_usage" in df.columns:
        sections.append(
            render_metric_table(
                df=df,
                title="Peak RAM Usage (bytes)",
                metric_col="memory_usage",
                col_groups=column_groups_opt,
                datasets=datasets,
                is_min_best=True,
                simplify_headers=True,
            )
        )

    index_path = output_dir / "index.html"
    index_path.write_text(build_html_page(sections), encoding="utf-8")
    print(index_path)


if __name__ == "__main__":
    main()
