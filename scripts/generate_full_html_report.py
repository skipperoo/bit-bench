#!/usr/bin/env python3

from __future__ import annotations

import argparse
import html
import http.server
import json
import re
import socketserver
from functools import partial
from pathlib import Path

import pandas as pd

# --- Global Configuration ---
EXCLUDED_METRICS = {
    "num_values",
    "original_size",
    "dataset_size",
    "dataset_base",
    "dataset_type",
    "source_results_csv",
    "input_buffer",
}

HIDDEN_METRICS = {"uncompressed_bits", "compressed_bits"}

METRIC_RENAMES = {
    "memory_usage": "Total Memory Usage",
    "compressor_internal": "Compressor Memory Usage",
    "internal_memory_ratio": "Compressor to input memory usage ratio",
    "compression_throughput_mbs": "Compression Throughput",
    "decompression_throughput_mbs": "Decompression Throughput",
    "random_access_ns": "Random Access Latency (ns)",
}

# Compressors to exclude from plots and tables
EXCLUDED_COMPRESSORS: set[str] = {"ALP"}

COMPRESSOR_RENAMES = {
    "b_star_gef_approximate": "B*-GEF (Approx)",
    "b_star_gef_optimal": "B*-GEF (Opt)",
    "b_gef_approximate": "B-GEF (Approx)",
    "b_gef_optimal": "B-GEF (Opt)",
    "rle_gef": "RLE-GEF",
    "u_gef_approximate": "U-GEF (Approx)",
    "u_gef_optimal": "U-GEF (Opt)",
    "snappy": "Snappy",
    "pfordelta_simdnewpfor": "PForDelta",
    "bzip2": "bzip2",
    "bzip3": "bzip3",
}


def rename_compressor(name: str) -> str:
    if name in COMPRESSOR_RENAMES:
        return COMPRESSOR_RENAMES[name]
    if name.startswith("gzip_"):
        rest = name[len("gzip_") :]
        return f"gzip ({rest})"
    return name


# Ordered from first to last. Unlisted metrics go to the end.
PREFERRED_ORDER = [
    "compression_ratio",
    "compressed_bits",
    "uncompressed_bits",
    "compression_throughput_mbs",
    "decompression_throughput_mbs",
    "memory_usage",
    "compressor_internal",
    "relative_memory_usage",
    "internal_memory_ratio",
    "random_access_ns",
    "random_access_mbs",
]


# --- Compressor families for ordering, shapes, and colors ---
COMPRESSOR_FAMILIES_ORDERED = [
    ("Block-sorting", ["bzip2", "bzip3"]),
    (
        "Dictionary-based",
        ["Brotli", "gzip (1)", "gzip (6)", "gzip (9)", "lz4", "Snappy", "XZ", "zstd"],
    ),
    (
        "Time Series",
        [
            "ALP1",
            "Camel",
            "Chimp",
            "Chimp128",
            "Elf",
            "Falcon",
            "Gorilla",
            "NeaTS",
            "TSXor",
        ],
    ),
    (
        "GEF",
        [
            "B*-GEF (Approx)",
            "B*-GEF (Opt)",
            "B-GEF (Approx)",
            "B-GEF (Opt)",
            "RLE-GEF",
            "U-GEF (Approx)",
            "U-GEF (Opt)",
        ],
    ),
    ("PForDelta", ["PForDelta"]),
    ("DAC", ["DAC"]),
]

COMPRESSOR_ORDER: list[str] = []
COMPRESSOR_FAMILY: dict[str, str] = {}
for fam, members in COMPRESSOR_FAMILIES_ORDERED:
    for m in members:
        COMPRESSOR_ORDER.append(m)
        COMPRESSOR_FAMILY[m.lower()] = fam

FAMILY_SHAPES = {
    "Block-sorting": "square",
    "Dictionary-based": "diamond",
    "Time Series": "circle",
    "GEF": "triangle-up",
    "PForDelta": "star",
    "DAC": "pentagon",
}

FAMILY_LATEX_MARKERS = {
    "Block-sorting": "square*",
    "Dictionary-based": "diamond*",
    "Time Series": "*",
    "GEF": "triangle*",
    "PForDelta": "star",
    "DAC": "pentagon*",
}

FALLBACK_SHAPES = ["cross", "x", "hexagram", "hash"]
FALLBACK_LATEX_MARKERS = ["cross", "x", "star", "asterisk"]

PLOTLY_COLOR_CYCLE = [
    "#1f77b4",
    "#ff7f0e",
    "#2ca02c",
    "#d62728",
    "#9467bd",
    "#8c564b",
    "#e377c2",
    "#e6194b",
    "#bcbd22",
    "#17becf",
]

LATEX_COLOR_CYCLE = [
    "blue",
    "red",
    "green",
    "orange",
    "purple",
    "brown",
    "pink",
    "magenta",
    "olive",
    "cyan",
]

# Fixed per-compressor color assignment (plotly_hex, latex_name).
# This ensures each compressor always gets the same color across all plots,
# regardless of which other compressors are present.
COMPRESSOR_COLORS: dict[str, tuple[str, str]] = {
    "B*-GEF (Approx)": ("#1f77b4", "blue"),
    "B*-GEF (Opt)": ("#ff7f0e", "red"),
    "B-GEF (Approx)": ("#2ca02c", "green"),
    "B-GEF (Opt)": ("#9467bd", "purple"),
    "RLE-GEF": ("#d62728", "orange"),
    "U-GEF (Approx)": ("#e377c2", "pink"),
    "U-GEF (Opt)": ("#bcbd22", "olive"),
    "bzip2": ("#8c564b", "brown"),
    "bzip3": ("#17becf", "cyan"),
    "Brotli": ("#17becf", "cyan"),
    "gzip (1)": ("#e6194b", "magenta"),
    "gzip (6)": ("#1f77b4", "blue"),
    "gzip (9)": ("#ff7f0e", "red"),
    "lz4": ("#2ca02c", "green"),
    "Snappy": ("#9467bd", "purple"),
    "XZ": ("#d62728", "orange"),
    "zstd": ("#e377c2", "pink"),
    "Camel": ("#9467bd", "purple"),
    "Chimp": ("#8c564b", "brown"),
    "Chimp128": ("#e377c2", "pink"),
    "Elf": ("#17becf", "cyan"),
    "Falcon": ("#e6194b", "magenta"),
    "Gorilla": ("#1f77b4", "blue"),
    "NeaTS": ("#ff7f0e", "red"),
    "TSXor": ("#d62728", "orange"),
    "PForDelta": ("#2ca02c", "green"),
    "DAC": ("#bcbd22", "olive"),
}

# Plotly marker symbols used for each family (must be valid plotly.js symbol names)
FAMILY_PLOTLY_SYMBOLS = {
    "Block-sorting": "square",
    "Dictionary-based": "diamond",
    "Time Series": "circle",
    "GEF": "triangle-up",
    "PForDelta": "star",
    "DAC": "pentagon",
}


def compressor_sort_key(name: str) -> tuple:
    lower_name = name.lower()
    for i, c in enumerate(COMPRESSOR_ORDER):
        if c.lower() == lower_name:
            return (0, i, name)
    return (1, 0, lower_name)


def get_compressor_family(name: str) -> str:
    return COMPRESSOR_FAMILY.get(name.lower(), "")


def get_family_color(name: str, is_latex: bool = False) -> str:
    lower_name = name.lower()
    # First try the fixed per-compressor map
    for canonical, (hex_c, latex_c) in COMPRESSOR_COLORS.items():
        if canonical.lower() == lower_name:
            return latex_c if is_latex else hex_c
    # Fallback: use family position (will rarely happen)
    family = get_compressor_family(name)
    members = []
    for fam, mems in COMPRESSOR_FAMILIES_ORDERED:
        if fam == family:
            members = mems
            break
    if members:
        lower_members = [m.lower() for m in members]
        try:
            idx = lower_members.index(lower_name)
        except ValueError:
            idx = 0
    else:
        idx = hash(name)
    colors = LATEX_COLOR_CYCLE if is_latex else PLOTLY_COLOR_CYCLE
    return colors[idx % len(colors)]


def get_family_shape(name: str, is_latex: bool = False) -> str:
    family = get_compressor_family(name)
    if family:
        if is_latex:
            return FAMILY_LATEX_MARKERS.get(family, "*")
        return FAMILY_PLOTLY_SYMBOLS.get(family, "circle")
    idx = hash(name) % len(FALLBACK_SHAPES)
    if is_latex:
        return FALLBACK_LATEX_MARKERS[idx]
    return FALLBACK_SHAPES[idx]


def is_min_best(metric: str) -> bool:
    lower_is_better = {
        "compression_ratio",
        "compressed_bits",
        "uncompressed_bits",
        "original_size",
        "memory_usage",
        "compressor_internal",
        "internal_memory_ratio",
        "relative_memory_usage",
        "random_access_ns",
    }
    return (
        metric in lower_is_better or metric.endswith("_ns") or metric.endswith("_bits")
    )


def format_metric_value(value: float, metric: str) -> str:
    if pd.isna(value):
        return "-"
    if metric == "compression_ratio":
        return f"{value * 100.0:.2f}"
    if metric in ["relative_memory_usage", "internal_memory_ratio"]:
        return f"{value:.4f}"
    if metric in ["memory_usage", "compressor_internal"]:
        if value < 1024:
            return f"{value:.2f} B"
        if value < 1024 * 1024:
            return f"{value / 1024:.2f} KB"
        return f"{value / 1024 / 1024:.2f} MB"
    return f"{value:.2f}"


def format_metric_name(metric: str) -> str:
    if metric in METRIC_RENAMES:
        return METRIC_RENAMES[metric]
    return metric.replace("_", " ").strip().title()


_SIGNAL_DATASET_RE = re.compile(
    r"^(?P<prefix>.+)_(?P<dtype>gap_shifted|std|gap)_(?P<size>\d+)$"
)


def parse_signal_dataset(dataset: str) -> dict[str, str] | None:
    """Parse dataset ids like 'wildppg_wrist_acc_x_gap_shifted_512'.

    Returns keys: base, location, family, channel, dtype, size.
    """

    s = str(dataset).strip()
    m = _SIGNAL_DATASET_RE.match(s)
    if not m:
        return None

    prefix = m.group("prefix")
    dtype = m.group("dtype")
    size = m.group("size")

    parts = prefix.split("_")
    if len(parts) < 3:
        return None

    base = parts[0]
    location = parts[1]
    family = parts[2]
    channel = "_".join(parts[3:]) if len(parts) > 3 else ""

    return {
        "base": base,
        "location": location,
        "family": family,
        "channel": channel,
        "dtype": dtype,
        "size": size,
    }


def format_signal_dataset_label(dataset: str) -> str:
    info = parse_signal_dataset(dataset)
    if not info:
        return str(dataset)

    family = info["family"]
    channel = info["channel"].replace("_", " ").strip()
    dtype = info["dtype"].replace("_", " ")
    size = info["size"]

    if channel:
        return f"{family} {channel} {dtype} {size}"
    return f"{family} {dtype} {size}"


def signal_dataset_sort_key(dataset: str) -> tuple:
    info = parse_signal_dataset(dataset)
    if not info:
        return (999, 999, 999, str(dataset))

    channel_order = {
        # ACC
        "x": 0,
        "y": 1,
        "z": 2,
        # PPG
        "r": 0,
        "g": 1,
        "ir": 2,
        # ECG (no channel)
        "": 0,
    }
    dtype_order = {"std": 0, "gap": 1, "gap_shifted": 2}

    channel = info["channel"]
    dtype = info["dtype"]
    size = int(info["size"]) if info["size"].isdigit() else 10**9

    return (
        size,
        dtype_order.get(dtype, 50),
        channel_order.get(channel, 50),
        str(dataset),
    )


def compression_ratio_soft_max(values: list[float]) -> float:
    if not values:
        return 105.0
    observed_max = max(values)
    if observed_max <= 100.0:
        return 105.0
    return max(105.0, observed_max * 1.08)


def rank_first_occurrence(
    values: list[float], lower_is_better: bool
) -> dict[float, int]:
    valid = [v for v in values if pd.notna(v)]
    ordered = sorted(valid, reverse=not lower_is_better)
    rank: dict[float, int] = {}
    for idx, value in enumerate(ordered):
        if value not in rank:
            rank[value] = idx
    return rank


def render_metric_table(
    metric: str,
    pivot_df: pd.DataFrame,
    lower_is_better: bool,
    table_id: str,
    dataset_label_fn=None,
    dataset_channel_map: dict[str, str] | None = None,
) -> str:
    compressors = list(pivot_df.columns)
    # Build header cells with family dividers
    header_cells = ""
    prev_family = None
    for c in compressors:
        family = get_compressor_family(c)
        cls = (
            ' class="family-divider"'
            if prev_family is not None and family != prev_family
            else ""
        )
        header_cells += f"<th{cls}>{html.escape(str(c))}</th>"
        prev_family = family

    def data_cell(value, extra_cls=""):
        classes = []
        if extra_cls:
            classes.append(extra_cls)
        if not pd.isna(value):
            rank = ranking.get(value, 999)
            if rank == 0:
                classes.append("rank-1")
            elif rank == 1:
                classes.append("rank-2")
            elif rank == 2:
                classes.append("rank-3")
        cls_attr = f' class="{" ".join(classes)}"' if classes else ""
        if pd.isna(value):
            return f"<td{cls_attr}>-</td>"
        display_value = format_metric_value(value, metric)
        raw_value = float(value)
        return f'<td{cls_attr} data-value="{raw_value}">{display_value}</td>'

    rows: list[str] = []
    for dataset, row in pivot_df.iterrows():
        raw_values = [row[c] for c in compressors]
        ranking = rank_first_occurrence(raw_values, lower_is_better)
        label = dataset_label_fn(dataset) if dataset_label_fn else dataset
        dataset_id_attr = f' data-dataset-id="{html.escape(str(dataset))}"'
        channel = dataset_channel_map.get(dataset, "") if dataset_channel_map else ""
        channel_attr = f' data-channel="{html.escape(channel)}"' if channel else ""
        cells: list[str] = []
        prev_family = None
        for compressor in compressors:
            family = get_compressor_family(compressor)
            extra = (
                "family-divider"
                if prev_family is not None and family != prev_family
                else ""
            )
            cells.append(data_cell(row[compressor], extra))
            prev_family = family
        rows.append(
            f"<tr><th{dataset_id_attr}{channel_attr}>{html.escape(str(label))}</th>{''.join(cells)}</tr>"
        )

    # Footer row with column averages (with ranking)
    avg_values: list[float | None] = []
    for compressor in compressors:
        vals = pivot_df[compressor].dropna()
        avg_values.append(vals.mean() if not vals.empty else None)

    valid_avgs = [v for v in avg_values if v is not None]
    avg_ranking = rank_first_occurrence(valid_avgs, lower_is_better)

    avg_cells: list[str] = []
    prev_family = None
    ranking = avg_ranking
    for i, compressor in enumerate(compressors):
        family = get_compressor_family(compressor)
        extra = (
            "family-divider"
            if prev_family is not None and family != prev_family
            else ""
        )
        avg_cells.append(data_cell(avg_values[i], extra))
        prev_family = family

    metric_label = format_metric_name(metric)
    unit_note = " (shown as %)" if metric == "compression_ratio" else ""
    direction = "Lower is better" if lower_is_better else "Higher is better"
    table_html = f"""
<div class="table-panel">
  <div class="metric-head">
    <p class="metric-note"><strong>{html.escape(metric_label)}</strong>{unit_note} — {direction} <span class="rank-legend">(bold = best, underline = 2nd, italic = 3rd)</span></p>
    <div class="copy-actions">
      <button type="button" class="copy-btn" onclick="copyTypstTable('{table_id}', this)">Copy Typst table</button>
      <button type="button" class="copy-btn" onclick="copyLatexTable('{table_id}', this)">Copy LaTeX table</button>
    </div>
  </div>
  <table id="{table_id}" class="metric-table" data-metric="{metric}">
    <thead>
      <tr><th>Dataset</th>{header_cells}</tr>
    </thead>
    <tbody>
      {"".join(rows)}
    </tbody>
    <tfoot>
      <tr><th>Average</th>{"".join(avg_cells)}</tr>
    </tfoot>
  </table>
</div>
""".strip()
    return table_html


FALLBACK_PALETTE = [
    "#1f77b4",
    "#ff7f0e",
    "#2ca02c",
    "#d62728",
    "#9467bd",
    "#8c564b",
    "#e377c2",
    "#7f7f7f",
    "#bcbd22",
    "#17becf",
]

COLORS_BY_SIZE: dict[str, str] = {}  # populated lazily


def get_size_color(size_val: str | int) -> str:
    # Standard colors for specific dataset sizes
    colors = {
        "512": "#1f77b4",
        "1536": "#ff7f0e",  # orange
        "8192": "#2ca02c",  # green
        "16384": "#d62728",  # red
        "32768": "#9467bd",  # purple
        "1572864": "#8c564b",  # brown
        "65536": "#e377c2",  # pink
        "131072": "#17becf",  # cyan
    }
    key = str(size_val)
    if key not in COLORS_BY_SIZE:
        COLORS_BY_SIZE[key] = (
            colors.get(key)
            or FALLBACK_PALETTE[len(COLORS_BY_SIZE) % len(FALLBACK_PALETTE)]
        )
    return COLORS_BY_SIZE[key]


def build_plot_spec(
    metric: str, averages: pd.DataFrame, grouped: pd.DataFrame
) -> tuple[list[dict], dict]:
    compressors = averages.index.tolist()
    has_ratio = "compression_ratio" in averages.columns
    ratios = (averages["compression_ratio"] * 100.0).tolist() if has_ratio else []

    if metric in [
        "memory_usage",
        "compressor_internal",
        "compression_ratio",
        "relative_memory_usage",
        "internal_memory_ratio",
    ]:
        metric_df = grouped[["dataset", "compressor", metric]].copy()

        y_label = format_metric_name(metric)
        if metric in ["memory_usage", "compressor_internal"]:
            metric_df[metric] = metric_df[metric] / 1024 / 1024
            y_label += " (MB)"
        elif metric == "compression_ratio":
            metric_df[metric] = metric_df[metric] * 100.0
            y_label += " (%)"

        pivot = metric_df.pivot(
            index="compressor", columns="dataset", values=metric
        ).reindex(index=compressors)

        # Custom sort for columns: by size (numeric) then type
        def dataset_sort_key(name):
            size_match = re.search(r"_(\d+)$", str(name))
            size_val = int(size_match.group(1)) if size_match else 0
            is_gap = 1 if "_gap_" in str(name) else 0
            is_gap_shifted = 1 if "_gap_shifted_" in str(name) else 0
            return (size_val, is_gap, is_gap_shifted, str(name))

        sorted_cols = sorted(pivot.columns, key=dataset_sort_key)
        pivot = pivot[sorted_cols]

        traces = []

        # Detect if all bar traces share the same size value — if so, use channel-based coloring
        all_sizes = set()
        for dataset in pivot.columns:
            size_match = re.search(r"_(\d+)$", str(dataset))
            if size_match:
                all_sizes.add(size_match.group(1))
        same_size_for_all = len(all_sizes) == 1 and len(pivot.columns) > 1

        CHANNEL_COLORS_MAP = {
            "x": "#1f77b4",
            "y": "#ff7f0e",
            "z": "#2ca02c",
            "r": "#d62728",
            "g": "#9467bd",
            "ir": "#8c564b",
        }
        legend_title = "Dataset (Colored by Size)"

        for dataset in pivot.columns:
            size_match = re.search(r"_(\d+)$", str(dataset))
            size_val = size_match.group(1) if size_match else ""

            if same_size_for_all and size_val:
                info = parse_signal_dataset(str(dataset))
                channel = (
                    info["channel"]
                    if isinstance(info, dict) and info.get("channel")
                    else ""
                )
                if channel:
                    legend_title = "Dataset (Colored by Channel)"
                    color = CHANNEL_COLORS_MAP.get(channel, get_size_color(size_val))
                else:
                    color = get_size_color(size_val)
            else:
                color = get_size_color(size_val)

            is_gap = "_gap_" in str(dataset) and "_gap_shifted_" not in str(dataset)
            is_gap_shifted = "_gap_shifted_" in str(dataset)

            trace = {
                "type": "bar",
                "name": str(dataset),
                "x": compressors,
                "y": pivot[dataset].tolist(),
                "marker": {},
            }
            if color:
                trace["marker"]["color"] = color

            if is_gap_shifted:
                trace["marker"]["pattern"] = {"shape": "."}
            elif is_gap:
                trace["marker"]["pattern"] = {"shape": "/"}

            traces.append(trace)

        layout = {
            "xaxis": {"title": {"text": "Compressor"}},
            "yaxis": {"title": {"text": y_label}},
            "barmode": "group",
            "legend": {
                "title": {"text": legend_title},
                "orientation": "h",
                "y": -0.5,
                "x": 0.5,
                "xanchor": "center",
                "yanchor": "top",
            },
            "margin": {
                "l": 85,
                "r": 55,
                "t": 75,
                "b": 200,
            },
            "automargin": True,
        }

        if metric == "compression_ratio":
            all_vals = [v for v in metric_df[metric] if pd.notna(v)]
            layout["yaxis"]["range"] = [0, compression_ratio_soft_max(all_vals)]

        return traces, layout

    y_values = averages[metric].tolist()
    if has_ratio and metric != "compression_ratio":
        x_values = ratios
        x_title = f"{format_metric_name('compression_ratio')} (%)"
        plot_title = f"Average {format_metric_name(metric)} vs {format_metric_name('compression_ratio')} (%) by compressor"
    else:
        x_values = compressors
        x_title = "Compressor"
        plot_title = f"Average {format_metric_name(metric)} by compressor"

    traces = []
    for compressor in compressors:
        y_val = y_values[compressors.index(compressor)]
        x_val = x_values[compressors.index(compressor)]
        if pd.isna(y_val) or pd.isna(x_val):
            continue
        traces.append(
            {
                "type": "scatter",
                "mode": "markers",
                "name": compressor,
                "x": [x_val],
                "y": [y_val],
                "marker": {
                    "size": 10,
                    "color": get_family_color(compressor),
                    "symbol": get_family_shape(compressor),
                },
            }
        )

    layout = {
        "xaxis": {"title": {"text": x_title}},
        "yaxis": {"title": {"text": format_metric_name(metric)}},
        "margin": {"l": 85, "r": 55, "t": 75, "b": 200},
        "legend": {"orientation": "h", "y": -0.5, "x": 0.5, "xanchor": "center"},
        "automargin": True,
    }
    return traces, layout


def build_compressor_scaling_report_html(
    compressor: str, df: pd.DataFrame, numeric_metrics: list[str]
) -> str:
    # Filter for this compressor
    df = df[df["compressor"] == compressor].copy()
    compressor = rename_compressor(compressor)
    if df.empty or "dataset_size" not in df.columns or "dataset_type" not in df.columns:
        return ""

    # Sort by size for plotting
    df = df.sort_values("dataset_size")

    sections: list[str] = []
    plot_scripts: list[str] = []

    for idx, metric in enumerate(numeric_metrics):
        if metric in HIDDEN_METRICS:
            continue

        plot_div_id = f"scaling-plot-{idx}"
        metric_label = format_metric_name(metric)

        # Color cycle for metrics (one color per plot)
        plot_color = [
            "#1f77b4",
            "#ff7f0e",
            "#2ca02c",
            "#d62728",
            "#9467bd",
            "#8c564b",
            "#e377c2",
        ][idx % 7]

        traces = []
        for dtype in sorted(df["dataset_type"].unique()):
            sub = df[df["dataset_type"] == dtype]
            # Average across different dataset bases for the same size/type
            scaling = sub.groupby("dataset_size")[metric].mean().reset_index()

            trace = {
                "type": "scatter",
                "mode": "lines+markers",
                "name": f"Type: {dtype}",
                "x": scaling["dataset_size"].tolist(),
                "y": scaling[metric].tolist(),
                "line": {"color": plot_color},
            }

            if dtype == "gap_shifted":
                trace["line"]["dash"] = "dot"
            elif dtype == "gap":
                trace["line"]["dash"] = "dash"

            traces.append(trace)

        y_axis_title = metric_label
        if metric in ["memory_usage", "compressor_internal"]:
            y_axis_title += " (MB)"
            for t in traces:
                t["y"] = [v / 1024 / 1024 for v in t["y"]]

        # Determine tick values for log scale: 10, 20, 50, 100, 200, 500, ...
        # Range: 10^3 to 10^7 roughly
        tick_vals = []
        for exp in range(3, 8):
            base = 10**exp
            tick_vals.extend([base, base * 2, base * 5])

        layout = {
            "title": {"text": f"{compressor}: {metric_label} vs Input Size"},
            "xaxis": {
                "title": {"text": "Input Size (Values)"},
                "type": "log",
                "tickvals": tick_vals,
                "tickformat": ".2s",
            },
            "yaxis": {"title": {"text": y_axis_title}},
            "margin": {"l": 85, "r": 55, "t": 75, "b": 80},
        }

        sections.append(
            f"""
<section class="overview-panel">
  <div id="{plot_div_id}" class="metric-plot"></div>
  <div class="plot-actions">
    <button type="button" class="copy-btn" onclick="copyScalingPlotAsLatex('{plot_div_id}', this)">Copy LaTeX</button>
  </div>
</section>
""".strip()
        )
        plot_scripts.append(
            f'Plotly.newPlot("{plot_div_id}", {json.dumps(traces)}, {json.dumps(layout)}, {{responsive: true}});'
        )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>{html.escape(compressor)} Scaling Report</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 24px; background: #fafafa; }}
    h1 {{ margin-bottom: 16px; }}
    .overview-panel {{
      margin-bottom: 24px;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 16px 20px;
    }}
    .metric-plot {{ width: 100%; min-height: 400px; }}
    .back-link {{ margin-bottom: 20px; display: block; }}
    .plot-actions {{
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }}
    .copy-btn {{
      border: 1px solid #bbb;
      border-radius: 6px;
      background: #fff;
      padding: 6px 10px;
      font-size: 0.86rem;
      cursor: pointer;
      white-space: nowrap;
    }}
    .copy-btn:hover {{
      background: #f3f3f3;
    }}
  </style>
</head>
<body>
  <a href="../index.html" class="back-link">← Back to Index</a>
  <h1>{html.escape(compressor)}: Scaling Analysis</h1>
  {"".join(sections)}
  <script>
    function latexEscapeStr(text) {{
      if (!text) return '';
      return text
        .replace(/\\\\/g, '\\\\\\\\')
        .replace(/&/g, '\\\\&')
        .replace(/%/g, '\\\\%')
        .replace(/\\$/g, '\\\\$')
        .replace(/#/g, '\\\\#')
        .replace(/_/g, '\\\\_')
        .replace(/\\{{/g, '\\\\{{')
        .replace(/\\}}/g, '\\\\}}');
    }}

    function plotlyColorToLatex(hex) {{
      const map = {{
        '#1f77b4': 'blue', '#ff7f0e': 'red', '#2ca02c': 'green',
        '#d62728': 'orange', '#9467bd': 'purple', '#8c564b': 'brown',
        '#e377c2': 'pink', '#e6194b': 'magenta', '#bcbd22': 'olive',
        '#17becf': 'cyan',
      }};
      return map[(hex || '').toLowerCase()] || 'black';
    }}

    function plotlySymbolToLatex(symbol) {{
      const map = {{
        'circle': '*',
        'square': 'square*',
        'diamond': 'diamond*',
        'triangle': 'triangle*',
        'triangle-up': 'triangle*',
        'star': 'star',
        'pentagon': 'pentagon*',
      }};
      return map[symbol] || '*';
    }}

    function copyScalingPlotAsLatex(plotDivId, button) {{
      const plotDiv = document.getElementById(plotDivId);
      if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;

      const traces = plotDiv.data;
      const layout = plotDiv.layout || {{}};
      const xAxis = layout.xaxis || {{}};
      const yAxis = layout.yaxis || {{}};

      const plotTitle = (layout.title && layout.title.text) || '';
      const xLabel = (xAxis.title && xAxis.title.text) || 'Input Size (Values)';
      const yLabel = (yAxis.title && yAxis.title.text) || '';
      const isLogX = xAxis.type === 'log';

      const lines = [];
      lines.push('\\\\begin{{figure}}[htbp]');
      lines.push('    \\\\centering');
      lines.push('    \\\\begin{{tikzpicture}}');
      lines.push('        \\\\begin{{axis}}[');
      lines.push('            title={{' + latexEscapeStr(plotTitle) + '}},');
      lines.push('            xlabel={{' + latexEscapeStr(xLabel) + '}},');
      lines.push('            ylabel={{' + latexEscapeStr(yLabel) + '}},');
      lines.push('            width=\\\\textwidth,');
      lines.push('            height=0.6\\\\textwidth,');
      if (traces.length > 4) {{
        lines.push('            legend style={{at={{(0.5,-0.18)}},anchor=north,legend columns=3}},');
      }} else {{
        lines.push('            legend pos=north east,');
      }}
      lines.push('            grid=major,');
      if (isLogX) lines.push('            xmode=log,');

      // Detect symbolic x-axis (categorical / non-numeric labels)
      const allXLabels = new Set();
      for (const t of traces) {{
        for (const x of t.x) {{
          if (typeof x !== 'number' && isNaN(parseFloat(x))) {{
            allXLabels.add(String(x));
          }}
        }}
      }}
      const hasSymbolic = allXLabels.size > 0;

      if (hasSymbolic) {{
        const labels = Array.from(allXLabels).map(l => latexEscapeStr(l)).join(',');
        lines.push('            symbolic x coords={{' + labels + '}},');
        lines.push('            xtick=data,');
      }}
      lines.push('        ]');
      lines.push('');

      for (let i = 0; i < traces.length; i++) {{
        const trace = traces[i];
        const hexColor = (trace.line && trace.line.color) || '';
        const color = plotlyColorToLatex(hexColor);
        const marker = (trace.marker && trace.marker.symbol) ? plotlySymbolToLatex(trace.marker.symbol) : '*';

        let dashOpts = '';
        if (trace.line && trace.line.dash) {{
          if (trace.line.dash === 'dash') dashOpts = ', dash pattern=on 4pt off 2pt';
          else if (trace.line.dash === 'dot') dashOpts = ', dash pattern=on 1pt off 2pt';
        }}

        const coords = [];
        for (let j = 0; j < trace.x.length; j++) {{
          const xRaw = trace.x[j];
          const yRaw = trace.y[j];
          const y = typeof yRaw === 'number' ? yRaw : parseFloat(yRaw);
          let xStr;
          if (typeof xRaw === 'number') {{
            xStr = String(xRaw);
          }} else {{
            const xNum = parseFloat(xRaw);
            xStr = isNaN(xNum) ? '{" + String(xRaw).replace(/[{{}}]/g, ) + "}' : String(xNum);
          }}
          coords.push('            (' + xStr + ',' + y + ')');
        }}

        lines.push('        \\\\addplot[');
        if (hasSymbolic) lines.push('            ybar,');
        lines.push('            color=' + color + ',');
        if (!hasSymbolic) lines.push('            mark=' + marker + dashOpts + ',');
        lines.push('        ]');
        lines.push('        coordinates {{');
        lines.push(coords.join('\\n'));
        lines.push('        }};');
        lines.push('        \\\\addlegendentry{{' + latexEscapeStr(trace.name || '') + '}}');
        lines.push('');
      }}

      lines.push('        \\\\end{{axis}}');
      lines.push('    \\\\end{{tikzpicture}}');
      lines.push('\\\\end{{figure}}');

      const text = lines.join('\\n');

      const original = button.textContent;
      try {{
        navigator.clipboard.writeText(text);
        button.textContent = 'Copied!';
      }} catch (e) {{
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        button.textContent = 'Copied!';
      }}
      setTimeout(function() {{ button.textContent = original; }}, 2000);
    }}

    {"".join(plot_scripts)}
  </script>
</body>
</html>
"""


def format_type_size_group_label(value: object) -> str:
    m = re.match(r"^avg_(gap_shifted|gap|std)_(\d+)$", str(value))
    if not m:
        return str(value)
    dtype = m.group(1)
    size = m.group(2)
    if dtype == "gap_shifted":
        dtype_display = "gap shifted"
    else:
        dtype_display = dtype
    return f"{dtype_display} {size}"


def infer_missing_type_and_size(df: pd.DataFrame) -> pd.DataFrame:
    """If dataset_type or dataset_size columns are missing, try to derive from dataset names.

    Signal dataset names like 'wildppg_wrist_acc_x_gap_shifted_512' encode the
    type (gap_shifted/gap/std) and size directly.
    """
    if df.empty:
        return df
    out = df.copy()
    need_type = "dataset_type" not in out.columns
    need_size = "dataset_size" not in out.columns
    if not need_type and not need_size:
        return out
    parsed = out["dataset"].astype(str).apply(parse_signal_dataset)
    if need_type:
        dtype_series = parsed.apply(
            lambda x: x["dtype"] if isinstance(x, dict) and "dtype" in x else None
        )
        if dtype_series.notna().any():
            out["dataset_type"] = dtype_series
    if need_size:
        size_series = parsed.apply(
            lambda x: x["size"] if isinstance(x, dict) and "size" in x else None
        )
        if size_series.notna().any():
            out["dataset_size"] = pd.to_numeric(size_series, errors="coerce")
    return out


def aggregate_full_report_by_type_and_size(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty or "dataset_type" not in df.columns or "dataset_size" not in df.columns:
        return df

    out = df.copy()

    dtype = out["dataset_type"].astype(str).str.strip()
    size_int = pd.to_numeric(out["dataset_size"], errors="coerce").astype("Int64")

    mask = dtype.notna() & (dtype != "") & size_int.notna()
    out.loc[mask, "dataset"] = (
        "avg_" + dtype[mask] + "_" + size_int[mask].astype(int).astype(str)
    )
    return out


def build_report_html(
    df: pd.DataFrame,
    source_label: str,
    *,
    page_title: str = "Benchmark full report",
    page_heading: str = "Benchmark full report",
    intro_html: str = "",
    dataset_label_fn=None,
    dataset_sort_key_fn=None,
) -> str:
    grouped = df.groupby(["dataset", "compressor"], as_index=False).mean(
        numeric_only=True
    )
    if EXCLUDED_COMPRESSORS:
        grouped = grouped[~grouped["compressor"].isin(EXCLUDED_COMPRESSORS)]
    if {"memory_usage", "original_size"} <= set(grouped.columns):
        grouped["relative_memory_usage"] = grouped["memory_usage"] / grouped[
            "original_size"
        ].replace(0, pd.NA)

    # Rename compressors for display
    grouped["compressor"] = grouped["compressor"].apply(rename_compressor)

    # Normalize case: map any compressor whose lowercase matches a family member
    # to the display-case name from COMPRESSOR_ORDER
    compressor_case_map = {}
    for c in COMPRESSOR_ORDER:
        compressor_case_map[c.lower()] = c
    grouped["compressor"] = grouped["compressor"].apply(
        lambda x: compressor_case_map.get(x.lower(), x)
    )

    # Reorder compressors by family, then alphabetically within family
    present = set(grouped["compressor"].unique())
    ordered = [c for c in COMPRESSOR_ORDER if c in present]
    present_remaining = present - set(ordered)
    ordered += sorted(present_remaining)
    grouped["compressor"] = pd.Categorical(
        grouped["compressor"], categories=ordered, ordered=True
    )

    # Detect signal channels for dataset-level subsignal filtering
    dataset_channel_map: dict[str, str] = {}
    for ds in grouped["dataset"].unique():
        info = parse_signal_dataset(ds)
        if isinstance(info, dict) and info.get("channel"):
            dataset_channel_map[ds] = info["channel"]
    available_channels = sorted(set(dataset_channel_map.values()))
    channel_map_json = json.dumps(dataset_channel_map)

    # Filter and sort metrics
    available_metrics = [
        c
        for c in grouped.columns
        if c not in {"dataset", "compressor"} and c not in EXCLUDED_METRICS
    ]

    # Sort by PREFERRED_ORDER
    def metric_sort_key(m):
        try:
            return PREFERRED_ORDER.index(m)
        except ValueError:
            return len(PREFERRED_ORDER)

    numeric_metrics = sorted(available_metrics, key=metric_sort_key)
    averages = grouped.groupby("compressor", observed=True)[numeric_metrics].mean()

    # Per-compressor average compression ratios for the client-side slider
    comp_ratio_avgs: dict[str, float] = {}
    if "compression_ratio" in averages.columns:
        for comp, val in averages["compression_ratio"].items():
            if pd.notna(val):
                comp_ratio_avgs[str(comp)] = round(val * 100.0, 2)
    comp_ratio_json = json.dumps(comp_ratio_avgs)
    all_compressors_json = json.dumps([str(c) for c in averages.index])

    # Prepare per-dataset, per-compressor data for client-side scatter plot recomputation
    grouped_records: list[dict] = []
    for _, grp_row in grouped.iterrows():
        rec: dict = {"d": str(grp_row["dataset"]), "c": str(grp_row["compressor"])}
        for m in numeric_metrics:
            v = grp_row.get(m)
            if pd.notna(v):
                rec[m] = round(float(v), 12)
        grouped_records.append(rec)
    grouped_data_json = json.dumps(grouped_records, separators=(",", ":"))

    channel_filter_html = ""
    if available_channels:
        ch_display = {c.lower(): c.upper() for c in available_channels}
        ch_boxes = "".join(
            f'<label><input type="checkbox" class="channel-filter" value="{c}" checked onchange="applyRowFilters()" /> {ch_display.get(c.lower(), c)}</label>'
            for c in available_channels
        )
        channel_filter_html = f'<div class="filter-group" id="channel-group"><span>Sub-signals:</span> {ch_boxes}</div>'

    sections: list[str] = []
    plot_scripts: list[str] = []
    overview_plot_html = ""
    if "compression_ratio" in averages.columns:
        overview_plot_id = "overview-compression-ratio-plot"
        overview_traces, overview_layout = build_plot_spec(
            "compression_ratio", averages, grouped
        )
        overview_plot_html = f"""
  <section class="overview-panel">
    <div id="{overview_plot_id}" class="metric-plot"></div>
    <div class="plot-actions">
      <button type="button" class="copy-btn" onclick="copyPlotAsLatex('{overview_plot_id}', this)">Copy LaTeX</button>
    </div>
  </section>
""".rstrip()
        plot_scripts.append(
            f'Plotly.newPlot("{overview_plot_id}", {json.dumps(overview_traces)}, {json.dumps(overview_layout)}, {{responsive: true}});'
        )

    for idx, metric in enumerate(numeric_metrics):
        if metric in HIDDEN_METRICS:
            continue

        pivot = grouped.pivot(
            index="dataset", columns="compressor", values=metric
        ).sort_index()

        # Dataset row ordering
        def default_dataset_sort_key(name):
            size_match = re.search(r"_(\d+)$", str(name))
            size_val = int(size_match.group(1)) if size_match else 0
            is_gap = 1 if "_gap_" in str(name) else 0
            is_gap_shifted = 1 if "_gap_shifted_" in str(name) else 0
            return (size_val, is_gap, is_gap_shifted, str(name))

        sort_key = dataset_sort_key_fn or default_dataset_sort_key
        sorted_rows = sorted(pivot.index, key=sort_key)
        pivot = pivot.reindex(sorted_rows)

        lower_is_better = is_min_best(metric)
        table_id = f"metric-table-{idx}"
        table_html = render_metric_table(
            metric,
            pivot,
            lower_is_better,
            table_id,
            dataset_label_fn=dataset_label_fn,
            dataset_channel_map=dataset_channel_map or None,
        )
        plot_div_id = f"metric-plot-{idx}"
        traces, layout = build_plot_spec(metric, averages, grouped)
        metric_label = format_metric_name(metric)

        sections.append(
            f"""
<details class="accordion">
  <summary>{html.escape(metric_label)}</summary>
  <div class="plot-panel">
    <div id="{plot_div_id}" class="metric-plot"></div>
    <div class="plot-actions">
      <button type="button" class="copy-btn" onclick="copyPlotAsLatex('{plot_div_id}', this)">Copy LaTeX</button>
    </div>
  </div>
  {table_html}
</details>
""".strip()
        )
        plot_scripts.append(
            f'Plotly.newPlot("{plot_div_id}", {json.dumps(traces)}, {json.dumps(layout)}, {{responsive: true}});'
        )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{html.escape(page_title)}</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 24px; background: #fafafa; }}
    h1 {{ margin-bottom: 8px; }}
    .intro {{ margin: 0 0 12px 0; color: #555; }}
    .overview-panel {{
      margin: 0 0 16px 0;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 16px 20px 10px 20px;
    }}
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
    .plot-panel {{
      padding: 16px 20px 6px 20px;
    }}
    .metric-plot {{
      width: 100%;
      min-height: 600px;
    }}
    .table-panel {{
      padding: 8px 14px 14px 14px;
      overflow-x: auto;
    }}
    .metric-head {{
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
      position: sticky;
      left: 0;
      z-index: 1;
    }}
    .metric-note {{
      margin: 0;
      color: #444;
    }}
    .copy-actions {{
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }}
    .copy-btn {{
      border: 1px solid #bbb;
      border-radius: 6px;
      background: #fff;
      padding: 6px 10px;
      font-size: 0.86rem;
      cursor: pointer;
      white-space: nowrap;
    }}
    .copy-btn:hover {{
      background: #f3f3f3;
    }}
    .plot-actions {{
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }}
    .picker-overlay {{
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    }}
    .picker-dialog {{
      background: #fff;
      width: min(560px, calc(100vw - 32px));
      max-height: calc(100vh - 48px);
      border-radius: 10px;
      border: 1px solid #ccc;
      box-shadow: 0 12px 35px rgba(0, 0, 0, 0.2);
      display: flex;
      flex-direction: column;
    }}
    .picker-head {{
      padding: 12px 14px;
      border-bottom: 1px solid #e6e6e6;
      font-weight: 600;
    }}
    .picker-controls {{
      padding: 10px 14px 0 14px;
      display: flex;
      gap: 8px;
    }}
    .picker-controls button {{
      border: 1px solid #bbb;
      border-radius: 6px;
      background: #fff;
      padding: 4px 8px;
      font-size: 0.82rem;
      cursor: pointer;
    }}
    .picker-list {{
      padding: 10px 14px;
      overflow: auto;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 12px;
    }}
    .picker-item {{
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.9rem;
    }}
    .picker-actions {{
      padding: 12px 14px;
      border-top: 1px solid #e6e6e6;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }}
    .picker-actions button {{
      border: 1px solid #bbb;
      border-radius: 6px;
      background: #fff;
      padding: 6px 10px;
      cursor: pointer;
    }}
    .picker-actions .primary {{
      background: #1f6feb;
      border-color: #1f6feb;
      color: #fff;
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      white-space: nowrap;
      font-size: 0.92rem;
      border-top: 2px solid #000;
      border-bottom: 2px solid #000;
    }}
    th, td {{
      padding: 5px 8px;
      text-align: center;
    }}
    thead th {{
      border-bottom: 1.5px solid #000;
      text-align: center;
      background: #d9d9d9;
      font-weight: 700;
    }}
    tbody th {{
      text-align: left;
      position: sticky;
      left: 0;
      background: #fff;
    }}
    .rank-1 {{ font-weight: 700; }}
    .rank-2 {{ text-decoration: underline; }}
    .rank-3 {{ font-style: italic; }}

    tfoot th, tfoot td {{
      border-top: 1.5px solid #000;
    }}
    tfoot th {{
      font-weight: 600;
      text-align: left;
    }}
    th.family-divider, td.family-divider {{
      border-left: 2.5px solid #000;
    }}

    .global-filters {{
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      flex-wrap: wrap;
      gap: 16px 24px;
      align-items: center;
      margin: 12px 0 16px 0;
      padding: 10px 14px;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 8px;
    }}
    .filter-group {{
      display: flex;
      align-items: center;
      gap: 8px;
    }}
    .filter-btn {{
      border: 1px solid #bbb;
      border-radius: 6px;
      background: #fff;
      padding: 6px 10px;
      font-size: 0.86rem;
      cursor: pointer;
    }}
    .filter-btn:hover {{
      background: #f3f3f3;
    }}
    #filter-status {{
      color: #555;
      font-size: 0.86rem;
      margin-left: auto;
    }}
  </style>
</head>
<body>
  <h1>{html.escape(page_heading)}</h1>
  {intro_html}
  <div class="global-filters">
    <div class="filter-group">
      <button type="button" class="filter-btn" onclick="showCompressorFilter()">Filter Compressors</button>
    </div>
    <div class="filter-group">
      <button type="button" class="filter-btn" onclick="showDatasetFilter()">Filter Datasets</button>
    </div>
    <div class="filter-group" id="ratio-group">
      <label>Filter by avg CR: <span id="ratio-value">200</span>%</label>
      <input type="range" id="ratio-slider" min="0" max="200" value="200" oninput="updateRatioFilter()" />
    </div>
    {channel_filter_html}
    <span id="filter-status">Showing all compressors</span>
  </div>
  <script id="compressor-data" type="application/json">{comp_ratio_json}</script>
  <script id="all-compressors" type="application/json">{all_compressors_json}</script>
  <script id="channel-map" type="application/json">{channel_map_json}</script>
  <script id="grouped-data" type="application/json">{grouped_data_json}</script>
  {overview_plot_html}
  {"".join(sections)}
  <script>
    function typstEscape(value) {{
      return value.replace(/\\\\/g, "\\\\\\\\").replace(/\\[/g, "\\\\[").replace(/\\]/g, "\\\\]");
    }}

    function escapeHtml(value) {{
      return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }}

    function cellNumericValue(cell) {{
      if (!cell) return NaN;
      const raw = cell.getAttribute("data-value");
      if (raw !== null && raw !== "") {{
        const num = Number.parseFloat(raw);
        return Number.isNaN(num) ? NaN : num;
      }}
      const text = (cell.textContent || "").trim();
      const num = Number.parseFloat(text);
      return Number.isNaN(num) ? NaN : num;
    }}

    function latexEscape(value) {{
      return value
        .replace(/&/g, "\\\\&")
        .replace(/%/g, "\\\\%")
        .replace(/\\$/g, "\\\\$")
        .replace(/#/g, "\\\\#")
        .replace(/_/g, "\\\\_");
    }}

    function latexEscapeStr(text) {{
      if (!text) return '';
      return latexEscape(text)
        .replace(/\\{{/g, '\\\\{{')
        .replace(/\\}}/g, '\\\\}}');
    }}

    function plotlyColorToLatex(hex) {{
      const map = {{
        '#1f77b4': 'blue', '#ff7f0e': 'red', '#2ca02c': 'green',
        '#d62728': 'orange', '#9467bd': 'purple', '#8c564b': 'brown',
        '#e377c2': 'pink', '#e6194b': 'magenta', '#bcbd22': 'olive',
        '#17becf': 'cyan',
      }};
      return map[(hex || '').toLowerCase()] || 'black';
    }}

    function plotlySymbolToLatex(symbol) {{
      const map = {{
        'circle': '*',
        'square': 'square*',
        'diamond': 'diamond*',
        'triangle': 'triangle*',
        'triangle-up': 'triangle*',
        'star': 'star',
        'pentagon': 'pentagon*',
      }};
      return map[symbol] || '*';
    }}

    function copyPlotAsLatex(plotDivId, button) {{
      const plotDiv = document.getElementById(plotDivId);
      if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;

      const traces = plotDiv.data;
      const layout = plotDiv.layout || {{}};
      const xAxis = layout.xaxis || {{}};
      const yAxis = layout.yaxis || {{}};

      const plotTitle = (layout.title && layout.title.text) || '';
      const xLabel = (xAxis.title && xAxis.title.text) || '';
      const yLabel = (yAxis.title && yAxis.title.text) || '';
      const isLogX = xAxis.type === 'log';
      const isLogY = yAxis.type === 'log';

      const lines = [];
      lines.push('\\\\begin{{figure}}[htbp]');
      lines.push('    \\\\centering');
      lines.push('    \\\\begin{{tikzpicture}}');
      lines.push('        \\\\begin{{axis}}[');
      if (plotTitle) lines.push('            title={{' + latexEscapeStr(plotTitle) + '}},');
      if (xLabel) lines.push('            xlabel={{' + latexEscapeStr(xLabel) + '}},');
      if (yLabel) lines.push('            ylabel={{' + latexEscapeStr(yLabel) + '}},');
      lines.push('            width=\\\\textwidth,');
      lines.push('            height=0.6\\\\textwidth,');
      if (traces.length > 4) {{
        lines.push('            legend style={{at={{(0.5,-0.18)}},anchor=north,legend columns=3}},');
      }} else {{
        lines.push('            legend pos=north east,');
      }}
      // Collect symbolic x labels (string categories like compressor names)
      const allXLabels = new Set();
      for (const t of traces) {{
        for (const x of t.x) {{
          if (typeof x !== 'number' && isNaN(parseFloat(x))) {{
            allXLabels.add(String(x));
          }}
        }}
      }}
      const hasSymbolic = allXLabels.size > 0;

      lines.push('            grid=major,');
      if (hasSymbolic) {{
        const labels = Array.from(allXLabels).map(l => latexEscapeStr(l)).join(',');
        lines.push('            symbolic x coords={{' + labels + '}},');
        lines.push('            xtick=data,');
      }}
      if (isLogX) lines.push('            xmode=log,');
      if (isLogY) lines.push('            ymode=log,');
      lines.push('        ]');
      lines.push('');

      for (let i = 0; i < traces.length; i++) {{
        const trace = traces[i];
        const color = (trace.marker && trace.marker.color) ? plotlyColorToLatex(trace.marker.color) : 'black';
        const marker = (trace.marker && trace.marker.symbol) ? plotlySymbolToLatex(trace.marker.symbol) : '*';

        let dashOpts = '';
        if (trace.line && trace.line.dash) {{
          if (trace.line.dash === 'dash') dashOpts = ', dash pattern=on 4pt off 2pt';
          else if (trace.line.dash === 'dot') dashOpts = ', dash pattern=on 1pt off 2pt';
        }}

        const coords = [];
        for (let j = 0; j < trace.x.length; j++) {{
          const xRaw = trace.x[j];
          const yRaw = trace.y[j];
          const y = typeof yRaw === 'number' ? yRaw : parseFloat(yRaw);
          let xStr;
          if (typeof xRaw === 'number') {{
            xStr = String(xRaw);
          }} else {{
            const xNum = parseFloat(xRaw);
            xStr = isNaN(xNum) ? '{" + String(xRaw).replace(/[{{}}]/g, ) + "}' : String(xNum);
          }}
          coords.push('            (' + xStr + ',' + y + ')');
        }}

        lines.push('        \\\\addplot[');
        if (hasSymbolic) lines.push('            ybar,');
        lines.push('            color=' + color + ',');
        if (!hasSymbolic) lines.push('            mark=' + marker + dashOpts + ',');
        lines.push('        ]');
        lines.push('        coordinates {{');
        lines.push(coords.join('\\n'));
        lines.push('        }};');
        lines.push('        \\\\addlegendentry{{' + latexEscapeStr(trace.name || '') + '}}');
        lines.push('');
      }}

      lines.push('        \\\\end{{axis}}');
      lines.push('    \\\\end{{tikzpicture}}');
      lines.push('\\\\end{{figure}}');

      const text = lines.join('\\n');

      const original = button.textContent;
      try {{
        navigator.clipboard.writeText(text);
        button.textContent = 'Copied!';
      }} catch (e) {{
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        button.textContent = 'Copied!';
      }}
      setTimeout(function() {{ button.textContent = original; }}, 2000);
    }}

    function latexCell(text, rank) {{
      const BS = String.fromCharCode(92);
      const LBR = String.fromCharCode(123);
      const RBR = String.fromCharCode(125);
      const escaped = latexEscape((text || "").trim());
      if (rank === 0) return BS + "textbf" + LBR + escaped + RBR;
      if (rank === 1) return BS + "underline" + LBR + escaped + RBR;
      if (rank === 2) return BS + "textit" + LBR + escaped + RBR;
      return escaped;
    }}

    function typstCellFromElement(element, rank) {{
      const text = typstEscape((element.textContent || "").trim());
      if (rank !== undefined) {{
        if (rank === 0) return `[#strong[${{text}}]]`;
        if (rank === 1) return `[#underline[${{text}}]]`;
        if (rank === 2) return `[#emph[${{text}}]]`;
        return `[${{text}}]`;
      }}
      if (element.classList.contains("rank-1")) return `[#strong[${{text}}]]`;
      if (element.classList.contains("rank-2")) return `[#underline[${{text}}]]`;
      if (element.classList.contains("rank-3")) return `[#emph[${{text}}]]`;
      return `[${{text}}]`;
    }}

    function showColumnPicker(compressors) {{
      return new Promise((resolve) => {{
        const overlay = document.createElement("div");
        overlay.className = "picker-overlay";
        const items = compressors
          .map((name, idx) =>
            `<label class="picker-item"><input type="checkbox" name="compressor" value="${{idx}}" checked />${{escapeHtml(name)}}</label>`
          )
          .join("");

        overlay.innerHTML = `
          <form class="picker-dialog">
            <div class="picker-head">Select compressors to export</div>
            <div class="picker-controls">
              <button type="button" data-action="all">Select all</button>
              <button type="button" data-action="none">Clear all</button>
            </div>
            <div class="picker-list">${{items}}</div>
            <div class="picker-actions">
              <button type="button" data-action="cancel">Cancel</button>
              <button type="submit" class="primary">Copy</button>
            </div>
          </form>
        `;

        const cleanup = () => {{
          overlay.remove();
        }};

        const dialog = overlay.querySelector(".picker-dialog");
        const checkboxes = Array.from(overlay.querySelectorAll('input[name="compressor"]'));

        overlay.addEventListener("click", (event) => {{
          if (event.target === overlay) {{
            cleanup();
            resolve(null);
          }}
        }});

        overlay.querySelector('[data-action="all"]').addEventListener("click", () => {{
          checkboxes.forEach((cb) => {{
            cb.checked = true;
          }});
        }});

        overlay.querySelector('[data-action="none"]').addEventListener("click", () => {{
          checkboxes.forEach((cb) => {{
            cb.checked = false;
          }});
        }});

        overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => {{
          cleanup();
          resolve(null);
        }});

        dialog.addEventListener("submit", (event) => {{
          event.preventDefault();
          const selected = checkboxes
            .filter((cb) => cb.checked)
            .map((cb) => Number.parseInt(cb.value, 10))
            .filter((idx) => Number.isInteger(idx))
            .sort((a, b) => a - b);
          cleanup();
          resolve(selected);
        }});

        document.body.appendChild(overlay);
      }});
    }}

    async function copyLatexTable(tableId, button) {{
      const table = document.getElementById(tableId);
      if (!table) return;
      const headerCells = Array.from(table.querySelectorAll("thead tr:first-child th"));
      if (headerCells.length < 2) return;

      const compressors = headerCells.slice(1).map((th) => (th.textContent || "").trim());
      const selectedCols = await showColumnPicker(compressors);
      if (selectedCols === null) return;
      if (!selectedCols.length) {{
        window.alert("No valid compressor selection. Nothing was copied.");
        return;
      }}

      const noteEl = table.closest(".table-panel").querySelector(".metric-note");
      const metricTitleEl = noteEl ? noteEl.querySelector("strong") : null;
      const metricTitle = metricTitleEl ? (metricTitleEl.textContent || "").trim() : "Metric";
      const lowerIsBetter = noteEl && noteEl.textContent.includes("Lower is better");
      const direction = lowerIsBetter ? "Lower is better" : "Higher is better";

      const BS = String.fromCharCode(92);
      const LBR = String.fromCharCode(123);
      const RBR = String.fromCharCode(125);
      const ROW_END = BS + BS;

      const selectedHeaders = ["Dataset", ...selectedCols.map((idx) => compressors[idx])];

      // Build column definition with vertical dividers between families
      const allHeaderTh = Array.from(table.querySelectorAll("thead tr:first-child th"));
      let colDef = "l";
      for (let si = 0; si < selectedCols.length; si++) {{
        const idx = selectedCols[si];
        const th = allHeaderTh[idx + 1]; // +1 because first th is "Dataset"
        if (si > 0 && th && th.classList.contains("family-divider")) {{
          colDef += "|c";
        }} else {{
          colDef += "c";
        }}
      }}

      const baseNameRaw = metricTitle.replace(/[^a-zA-Z]/g, "");
      const baseName = baseNameRaw ? baseNameRaw : "Export";
      const headerCmd = baseName + "Header";
      const rowsCmd = baseName + "Rows";

      const headerLine =
        selectedHeaders
          .map((h) => BS + "textbf" + LBR + latexEscape(h) + RBR)
          .join(" & ") +
        ROW_END;

      const bodyLines = [];
      const bodyRows = Array.from(table.querySelectorAll("tbody tr")).filter(
        (tr) => tr.style.display !== "none"
      );
      bodyRows.forEach((tr) => {{
        const datasetCell = tr.querySelector("th");
        const metricCells = Array.from(tr.querySelectorAll("td"));
        const pickedMetricCells = selectedCols.map((idx) => metricCells[idx]);

        const values = pickedMetricCells.map(cellNumericValue);
        const validEntries = values
          .map((v, i) => ({{ v, i }}))
          .filter((x) => !isNaN(x.v));
        validEntries.sort((a, b) => (lowerIsBetter ? a.v - b.v : b.v - a.v));
        const rankByValue = {{}};
        let currentRank = 0;
        validEntries.forEach((item) => {{
          if (!(item.v in rankByValue)) {{
            rankByValue[item.v] = currentRank++;
          }}
        }});

        const datasetText = latexEscape((datasetCell.textContent || "").trim());
        const rowCells = [
          datasetText,
          ...pickedMetricCells.map((cell, i) => {{
            const val = values[i];
            const rank = !isNaN(val) ? (rankByValue[val] ?? 999) : 999;
            return latexCell((cell.textContent || "").trim(), rank);
          }}),
        ];
        bodyLines.push(rowCells.join(" & ") + ROW_END);
      }});

      // Include footer (average) rows
      const footRows = Array.from(table.querySelectorAll("tfoot tr")).filter(
        (tr) => tr.style.display !== "none"
      );
      if (footRows.length) {{
        bodyLines.push(BS + "midrule");
      }}
      footRows.forEach((tr) => {{
        const datasetCell = tr.querySelector("th");
        const metricCells = Array.from(tr.querySelectorAll("td"));
        const pickedMetricCells = selectedCols.map((idx) => metricCells[idx]);

        const values = pickedMetricCells.map(cellNumericValue);
        const validEntries = values
          .map((v, i) => ({{ v, i }}))
          .filter((x) => !isNaN(x.v));
        validEntries.sort((a, b) => (lowerIsBetter ? a.v - b.v : b.v - a.v));
        const rankByValue = {{}};
        let currentRank = 0;
        validEntries.forEach((item) => {{
          if (!(item.v in rankByValue)) {{
            rankByValue[item.v] = currentRank++;
          }}
        }});

        const datasetText = BS + "textbf" + LBR + latexEscape((datasetCell.textContent || "").trim()) + RBR;
        const rowCells = [
          datasetText,
          ...pickedMetricCells.map((cell, i) => {{
            const val = values[i];
            const rank = !isNaN(val) ? (rankByValue[val] ?? 999) : 999;
            return latexCell((cell.textContent || "").trim(), rank);
          }}),
        ];
        bodyLines.push(rowCells.join(" & ") + ROW_END);
      }});

      const lines = [];
      lines.push("% Converted 1:1 from HTML report export.");
      lines.push("% " + latexEscape(metricTitle) + " — " + direction);
      lines.push("% Tabular columns: " + colDef);
      lines.push("");

      lines.push(BS + "newcommand" + LBR + BS + headerCmd + RBR + LBR + "%");
      lines.push("  " + headerLine);
      lines.push(RBR);
      lines.push("");

      lines.push(BS + "newcommand" + LBR + BS + rowsCmd + RBR + LBR + "%");
      bodyLines.forEach((line) => lines.push("  " + line));
      lines.push(RBR);
      lines.push("");

      const safeMetricTitle = latexEscape(metricTitle);
      const tableLabel = baseName.toLowerCase();

      lines.push("% --- Paste into your main .tex (e.g., report.tex) ---");
      lines.push(BS + "begin" + LBR + "table" + RBR + "[htbp]");
      lines.push(BS + "caption" + LBR + safeMetricTitle + " " + BS + "textbf" + LBR + "Bold" + RBR + ": Best, " + BS + "underline" + LBR + "Underlined" + RBR + ": Second, " + BS + "textit" + LBR + "Italics" + RBR + ": Third." + RBR);
      lines.push(BS + "label" + LBR + "tab:" + tableLabel + RBR);
      lines.push(BS + "centering");
      lines.push(BS + "scriptsize");
      lines.push(BS + "setlength" + LBR + BS + "tabcolsep" + RBR + LBR + "3pt" + RBR);
      lines.push(BS + "begin" + LBR + "tabular" + RBR + LBR + "@{{}}" + colDef + "@{{}}" + RBR);
      lines.push(BS + "toprule");
      lines.push(BS + headerCmd);
      lines.push(BS + "midrule");
      lines.push(BS + rowsCmd);
      lines.push(BS + "bottomrule");
      lines.push(BS + "end" + LBR + "tabular" + RBR);
      lines.push(BS + "end" + LBR + "table" + RBR);

      const text = lines.join("\\n");

      const original = button.textContent;
      try {{
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
      }} catch (error) {{
        const area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
        button.textContent = "Copied";
      }}
      setTimeout(() => {{
        button.textContent = original;
      }}, 1200);
    }}

    async function copyTypstTable(tableId, button) {{
      const table = document.getElementById(tableId);
      if (!table) return;
      const headerCells = Array.from(table.querySelectorAll("thead tr:first-child th"));
      if (headerCells.length < 2) return;

      const compressors = headerCells.slice(1).map((th) => (th.textContent || "").trim());
      const selectedCols = await showColumnPicker(compressors);
      if (selectedCols === null) return;
      if (!selectedCols.length) {{
        window.alert("No valid compressor selection. Nothing was copied.");
        return;
      }}

      const noteEl = table.closest(".table-panel").querySelector(".metric-note");
      const lowerIsBetter = noteEl && noteEl.textContent.includes("Lower is better");

      const selectedHeaders = ["Dataset", ...selectedCols.map((idx) => compressors[idx])];

      const rows = [];
      const bodyRows = Array.from(table.querySelectorAll("tbody tr")).filter(
        (tr) => tr.style.display !== "none"
      );
      bodyRows.forEach((tr) => {{
        const datasetCell = tr.querySelector("th");
        const metricCells = Array.from(tr.querySelectorAll("td"));
        const pickedMetricCells = selectedCols.map((idx) => metricCells[idx]);

        const values = pickedMetricCells.map(cellNumericValue);
        const validEntries = values
          .map((v, i) => ({{ v, i }}))
          .filter((x) => !isNaN(x.v));
        validEntries.sort((a, b) => (lowerIsBetter ? a.v - b.v : b.v - a.v));
        const rankByValue = {{}};
        let currentRank = 0;
        validEntries.forEach((item) => {{
          if (!(item.v in rankByValue)) {{
            rankByValue[item.v] = currentRank++;
          }}
        }});

        rows.push([
          typstCellFromElement(datasetCell),
          ...pickedMetricCells.map((cell, i) => {{
            const val = values[i];
            const rank = !isNaN(val) ? (rankByValue[val] ?? 999) : 999;
            return typstCellFromElement(cell, rank);
          }}),
        ]);
      }});

      const footRows = Array.from(table.querySelectorAll("tfoot tr")).filter(
        (tr) => tr.style.display !== "none"
      );
      footRows.forEach((tr) => {{
        const datasetCell = tr.querySelector("th");
        const metricCells = Array.from(tr.querySelectorAll("td"));
        const pickedMetricCells = selectedCols.map((idx) => metricCells[idx]);

        const values = pickedMetricCells.map(cellNumericValue);
        const validEntries = values
          .map((v, i) => ({{ v, i }}))
          .filter((x) => !isNaN(x.v));
        validEntries.sort((a, b) => (lowerIsBetter ? a.v - b.v : b.v - a.v));
        const rankByValue = {{}};
        let currentRank = 0;
        validEntries.forEach((item) => {{
          if (!(item.v in rankByValue)) {{
            rankByValue[item.v] = currentRank++;
          }}
        }});

        rows.push([
          `[*${{typstEscape((datasetCell.textContent || "").trim())}}*]`,
          ...pickedMetricCells.map((cell, i) => {{
            const val = values[i];
            const rank = !isNaN(val) ? (rankByValue[val] ?? 999) : 999;
            return typstCellFromElement(cell, rank);
          }}),
        ]);
      }});

      const allHeaderTh = Array.from(table.querySelectorAll("thead tr:first-child th"));
      const vlineBefore = [];
      for (let si = 0; si < selectedCols.length; si++) {{
        const idx = selectedCols[si];
        const th = allHeaderTh[idx + 1];
        if (si > 0 && th && th.classList.contains("family-divider")) {{
          vlineBefore.push(si);
        }}
      }}

      const headerParts = [];
      headerParts.push(`    table.cell(fill: luma(220), [*${{typstEscape(selectedHeaders[0])}}*]),`);
      for (let si = 0; si < selectedCols.length; si++) {{
        if (vlineBefore.includes(si)) {{
          headerParts.push(`    table.vline(stroke: 0.8pt),`);
        }}
        headerParts.push(`    table.cell(fill: luma(220), [*${{typstEscape(selectedHeaders[si + 1])}}*]),`);
      }}
      const headerTypst = headerParts.join("\\n");

      const interleaveRow = (row) => {{
        const parts = [];
        parts.push(`    ${{row[0]}},`);
        for (let si = 0; si < selectedCols.length; si++) {{
          if (vlineBefore.includes(si)) {{
            parts.push(`    table.vline(stroke: 0.8pt),`);
          }}
          parts.push(`    ${{row[si + 1]}},`);
        }}
        return "  (\\n" + parts.join("\\n") + "\\n  ),";
      }};
      const rowsTypst = rows.map(interleaveRow).join("\\n");
      const n = selectedHeaders.length;
      const m = rows.length + 1;
      const text =
`#let n = ${{n}}
#let m = ${{m}}

#let header = (
${{headerTypst}}
)

#let rows = (
${{rowsTypst}}
)

#table(
  columns: n,
  stroke: (x: 0pt, y: 0.4pt),
  align: (left,) + (center,) * (n - 1),
  table.hline(stroke: 1.2pt, position: top),
  table.hline(stroke: 1.2pt, position: bottom),
  ..header,
  ..rows.flatten(),
)`;

      const original = button.textContent;
      try {{
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
      }} catch (error) {{
        const area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
        button.textContent = "Copied";
      }}
      setTimeout(() => {{
        button.textContent = original;
      }}, 1200);
    }}

    // --- Global filter state ---
    window.__compressorAvgs = JSON.parse(document.getElementById('compressor-data').textContent);
    window.__allCompressors = JSON.parse(document.getElementById('all-compressors').textContent);
    window.__selectedCompressors = [...window.__allCompressors];
    if (!Object.keys(window.__compressorAvgs).length) {{
      const rg = document.getElementById('ratio-group');
      if (rg) rg.style.display = 'none';
    }}

    function filterTraceData(trace, visible) {{
      if (!Array.isArray(trace.x)) return trace;
      // Per-compressor traces (scatter: name holds the compressor)
      if (trace.type === 'scatter' && trace.name) {{
        if (visible.has(trace.name)) return trace;
        return {{ ...trace, x: [], y: [] }};
      }}
      // Bar/line charts with multiple compressors: null out non-visible y values
      // but keep x-axis intact so Plotly's grouped barmode renders correctly
      const names = Array.isArray(trace.text) ? trace.text : trace.x;
      const result = {{ ...trace }};
      if (Array.isArray(result.y)) {{
        result.y = result.y.map((v, i) => visible.has(names[i]) ? v : null);
      }}
      return result;
    }}

    function showCompressorFilter() {{
      const overlay = document.createElement('div');
      overlay.className = 'picker-overlay';
      const items = window.__allCompressors
        .map((name, idx) =>
          `<label class="picker-item"><input type="checkbox" name="comp-filter" value="${{idx}}" ${{window.__selectedCompressors.includes(name) ? 'checked' : ''}} />${{escapeHtml(name)}}</label>`
        )
        .join('');

      overlay.innerHTML = `
        <form class="picker-dialog">
          <div class="picker-head">Select compressors to display</div>
          <div class="picker-controls">
            <button type="button" data-action="all">Select all</button>
            <button type="button" data-action="none">Clear all</button>
          </div>
          <div class="picker-list">${{items}}</div>
          <div class="picker-actions">
            <button type="button" data-action="cancel">Cancel</button>
            <button type="submit" class="primary">Apply</button>
          </div>
        </form>
      `;

      const cleanup = () => {{ overlay.remove(); }};
      const dialog = overlay.querySelector('.picker-dialog');
      const checkboxes = Array.from(overlay.querySelectorAll('input[name="comp-filter"]'));

      overlay.addEventListener('click', (event) => {{
        if (event.target === overlay) {{ cleanup(); }}
      }});

      overlay.querySelector('[data-action="all"]').addEventListener('click', () => {{
        checkboxes.forEach((cb) => {{ cb.checked = true; }});
      }});

      overlay.querySelector('[data-action="none"]').addEventListener('click', () => {{
        checkboxes.forEach((cb) => {{ cb.checked = false; }});
      }});

      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => {{
        cleanup();
      }});

      dialog.addEventListener('submit', (event) => {{
        event.preventDefault();
        window.__selectedCompressors = checkboxes
          .filter((cb) => cb.checked)
          .map((cb) => window.__allCompressors[Number.parseInt(cb.value, 10)])
          .filter(Boolean);
        cleanup();
        applyFilter();
      }});

      document.body.appendChild(overlay);
    }}

    function updateRatioFilter() {{
      const slider = document.getElementById('ratio-slider');
      document.getElementById('ratio-value').textContent = slider.value;
      applyFilter();
    }}

    function getVisibleCompressors() {{
      const maxRatio = parseFloat(document.getElementById('ratio-slider').value);
      return window.__selectedCompressors.filter(name => {{
        const avg = window.__compressorAvgs[name];
        return avg === undefined || avg <= maxRatio;
      }});
    }}

    function applyFilter() {{
      const visible = new Set(getVisibleCompressors());

      document.querySelectorAll('.metric-table').forEach(table => {{
        const headers = Array.from(table.querySelectorAll('thead tr:first-child th'));
        const compNames = headers.slice(1).map(th => (th.textContent || '').trim());
        headers.forEach((th, i) => {{
          if (i === 0) return;
          th.style.display = visible.has(compNames[i - 1]) ? '' : 'none';
        }});
        table.querySelectorAll('tbody tr, tfoot tr').forEach(tr => {{
          const cells = Array.from(tr.querySelectorAll('td'));
          cells.forEach((td, i) => {{
            td.style.display = visible.has(compNames[i]) ? '' : 'none';
          }});
        }});
        try {{ recalcFooterRanking(table); }} catch(e) {{}}
      }});

      document.querySelectorAll('.metric-plot').forEach(div => {{
        if (!div.id || !div.data) return;
        if (!div.__originalData) div.__originalData = div.data;
        const filtered = Array.from(div.__originalData).map(t => filterTraceData(t, visible));
        Plotly.react(div, filtered, div.layout);
      }});

      const total = window.__allCompressors.length;
      const shown = visible.size;
      document.getElementById('filter-status').textContent =
        shown === total ? 'Showing all compressors' : `Showing ${{shown}}/${{total}} compressors`;
    }}

    // --- Footer average helpers ---
    function formatRecalcValue(rawValue, metric, sampleText) {{
      if (metric === 'compression_ratio') {{
        return (rawValue * 100).toFixed(2);
      }}
      if (metric === 'relative_memory_usage' || metric === 'internal_memory_ratio') {{
        return rawValue.toFixed(4);
      }}
      if (metric === 'memory_usage' || metric === 'compressor_internal') {{
        if (rawValue < 1024) return rawValue.toFixed(2) + ' B';
        if (rawValue < 1024 * 1024) return (rawValue / 1024).toFixed(2) + ' KB';
        return (rawValue / (1024 * 1024)).toFixed(2) + ' MB';
      }}
      if (sampleText.includes('MB')) {{
        return (rawValue / (1024 * 1024)).toFixed(2) + ' MB';
      }}
      if (sampleText.includes('KB')) {{
        return (rawValue / 1024).toFixed(2) + ' KB';
      }}
      if (sampleText.includes(' B') && !sampleText.includes('KB') && !sampleText.includes('MB')) {{
        return rawValue.toFixed(2) + ' B';
      }}
      return rawValue.toFixed(2);
    }}

    function recalcFooterAverages(table) {{
      const headers = Array.from(table.querySelectorAll('thead tr:first-child th'));
      const compCount = headers.length - 1;
      const tbody = table.querySelector('tbody');
      const tfoot = table.querySelector('tfoot');
      if (!tbody || !tfoot) return;

      const bodyRows = Array.from(tbody.querySelectorAll('tr')).filter(tr => tr.style.display !== 'none');
      const footRow = tfoot.querySelector('tr:first-child');
      if (!footRow) return;

      const footCells = Array.from(footRow.querySelectorAll('td'));
      const firstVisible = footCells.find(td => td.style.display !== 'none');
      const sampleText = firstVisible ? (firstVisible.textContent || '') : '';
      const metric = table.dataset.metric || '';

      const colValues = Array.from({{length: compCount}}, () => []);
      bodyRows.forEach(tr => {{
        const cells = Array.from(tr.querySelectorAll('td'));
        cells.forEach((td, i) => {{
          if (td.style.display === 'none') return;
          const val = cellNumericValue(td);
          if (!isNaN(val)) colValues[i].push(val);
        }});
      }});

      footCells.forEach((td, i) => {{
        const vals = colValues[i];
        if (vals.length === 0) {{
          td.textContent = '-';
          td.removeAttribute('data-value');
          return;
        }}
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        td.setAttribute('data-value', avg.toString());
        td.textContent = formatRecalcValue(avg, metric, sampleText);
      }});
    }}

    function recalcFooterRanking(table) {{
      const tfoot = table.querySelector('tfoot');
      if (!tfoot) return;
      const footRow = tfoot.querySelector('tr:first-child');
      if (!footRow) return;

      const panel = table.closest('.table-panel');
      if (!panel) return;
      const noteEl = panel.querySelector('.metric-note');
      const lowerIsBetter = noteEl && noteEl.textContent.includes('Lower is better');

      const cells = Array.from(footRow.querySelectorAll('td'));
      const visible = [];
      cells.forEach(td => {{
        if (td.style.display === 'none') return;
        const val = cellNumericValue(td);
        if (!isNaN(val)) visible.push({{td, val}});
      }});

      visible.sort((a, b) => lowerIsBetter ? a.val - b.val : b.val - a.val);
      const rankByVal = {{}};
      let rank = 0;
      visible.forEach(item => {{
        if (!(item.val in rankByVal)) rankByVal[item.val] = rank++;
      }});

      visible.forEach(item => {{
        const r = rankByVal[item.val];
        item.td.classList.remove('rank-1', 'rank-2', 'rank-3');
        if (r === 0) item.td.classList.add('rank-1');
        else if (r === 1) item.td.classList.add('rank-2');
        else if (r === 2) item.td.classList.add('rank-3');
      }});
    }}

    // --- Row filters (sub-signal channels + dataset selection) ---
    window.__channelMap = (function() {{
      try {{ return JSON.parse(document.getElementById('channel-map').textContent); }}
      catch(e) {{ return {{}}; }}
    }})();

    window.__allDatasets = []; // entries as (id, label)
    window.__selectedDatasetIds = [];

    function initDatasetFilter() {{
      const entries = [];
      const seen = new Set();
      document.querySelectorAll('.metric-table tbody tr').forEach(tr => {{
        const th = tr.querySelector('th');
        if (!th) return;
        const label = (th.textContent || '').trim();
        const id = ((th.getAttribute('data-dataset-id') || label) || '').trim();
        if (!id) return;
        if (!seen.has(id)) {{
          seen.add(id);
          entries.push({{id, label}});
        }}
      }});
      window.__allDatasets = entries;
      window.__selectedDatasetIds = entries.map(e => e.id);
    }}

    function showDatasetFilter() {{
      const overlay = document.createElement('div');
      overlay.className = 'picker-overlay';
      const items = window.__allDatasets
        .map((entry, idx) =>
          `<label class="picker-item"><input type="checkbox" name="ds-filter" value="${{idx}}" ${{window.__selectedDatasetIds.includes(entry.id) ? 'checked' : ''}} />${{escapeHtml(entry.label)}}</label>`
        ).join('');

      overlay.innerHTML = `
        <form class="picker-dialog">
          <div class="picker-head">Select datasets to display</div>
          <div class="picker-controls">
            <button type="button" data-action="all">Select all</button>
            <button type="button" data-action="none">Clear all</button>
          </div>
          <div class="picker-list">${{items}}</div>
          <div class="picker-actions">
            <button type="button" data-action="cancel">Cancel</button>
            <button type="submit" class="primary">Apply</button>
          </div>
        </form>
      `;

      const cleanup = () => {{ overlay.remove(); }};
      const dialog = overlay.querySelector('.picker-dialog');
      const checkboxes = Array.from(overlay.querySelectorAll('input[name="ds-filter"]'));

      overlay.addEventListener('click', (event) => {{
        if (event.target === overlay) cleanup();
      }});

      overlay.querySelector('[data-action="all"]').addEventListener('click', () => {{
        checkboxes.forEach(cb => cb.checked = true);
      }});

      overlay.querySelector('[data-action="none"]').addEventListener('click', () => {{
        checkboxes.forEach(cb => cb.checked = false);
      }});

      overlay.querySelector('[data-action="cancel"]').addEventListener('click', cleanup);

      dialog.addEventListener('submit', (event) => {{
        event.preventDefault();
        window.__selectedDatasetIds = checkboxes
          .filter(cb => cb.checked)
          .map(cb => window.__allDatasets[Number.parseInt(cb.value, 10)])
          .filter(Boolean)
          .map(entry => entry.id)
          .filter(Boolean);
        cleanup();
        applyRowFilters();
      }});

      document.body.appendChild(overlay);
    }}

    function applyRowFilters() {{
      const chMap = window.__channelMap;
      const hasChFilter = Object.keys(chMap).length > 0;
      const chChecked = new Set(
        Array.from(document.querySelectorAll('.channel-filter:checked')).map(cb => cb.value)
      );
      const allChChecked = chChecked.size === document.querySelectorAll('.channel-filter').length;
      const hasDsFilter = window.__allDatasets.length > 0 &&
        window.__selectedDatasetIds.length < window.__allDatasets.length;
      const dsSet = new Set(window.__selectedDatasetIds);

      // Filter table rows (skip tfoot — handled separately by recalcFooterAverages)
      document.querySelectorAll('.metric-table').forEach(table => {{
        table.querySelectorAll('tbody tr').forEach(tr => {{
          const th = tr.querySelector('th');
          if (!th) return;
          const label = (th.textContent || '').trim();
          const datasetId = ((th.getAttribute('data-dataset-id') || label) || '').trim();
          const channel = th.getAttribute('data-channel') || '';
          let visible = true;
          if (hasChFilter && channel && !chChecked.has(channel)) visible = false;
          if (hasDsFilter && !dsSet.has(datasetId)) visible = false;
          tr.style.display = visible ? '' : 'none';
        }});
        recalcFooterAverages(table);
        try {{ recalcFooterRanking(table); }} catch(e) {{}}
      }});

      // Filter plot traces (bar charts) and recompute scatter plots
      window.__groupedData = window.__groupedData || JSON.parse(
        (document.getElementById('grouped-data') || {{textContent: '[]'}}).textContent
      );
      document.querySelectorAll('.metric-plot').forEach(div => {{
        if (!div.id || !div.data || !div.data.length) return;
        if (div.data[0].type === 'bar') {{
          if (!div.__channelOriginal) div.__channelOriginal = div.data;
          const filtered = Array.from(div.__channelOriginal).map(t => {{
            if (t.type === 'bar' && t.name) {{
              const ch = chMap[t.name] || '';
              const chOk = !hasChFilter || !ch || allChChecked || chChecked.has(ch);
              const dsOk = !hasDsFilter || dsSet.has(t.name);
              if (!chOk || !dsOk) {{
                return {{...t, x: [], y: []}};
              }}
            }}
            return t;
          }});
          Plotly.react(div, filtered, div.layout);
          delete div.__originalData;
        }} else if (div.data[0].type === 'scatter') {{
          const accordion = div.closest('.accordion');
          if (!accordion) return;
          const table = accordion.querySelector('.metric-table');
          if (!table) return;
          const metric = table.dataset.metric;
          if (!metric) return;
          const isVsRatio = div.data[0].x.length > 0 && typeof div.data[0].x[0] === 'number';
          // Collect visible dataset IDs from this table (channel+dataset filter applied)
          const visibleDs = new Set();
          table.querySelectorAll('tbody tr').forEach(tr => {{
            if (tr.style.display === 'none') return;
            const th = tr.querySelector('th');
            if (!th) return;
            const label = (th.textContent || '').trim();
            const id = ((th.getAttribute('data-dataset-id') || label) || '').trim();
            if (id) visibleDs.add(id);
          }});
          div.data.forEach(trace => {{
            const name = trace.name;
            if (!name) return;
            const compData = window.__groupedData.filter(
              r => r.c === name && r[metric] != null && visibleDs.has(r.d)
            );
            if (!compData.length) {{
              trace.x = [];
              trace.y = [];
              return;
            }}
            const yAvg = compData.reduce((s, r) => s + r[metric], 0) / compData.length;
            if (isVsRatio) {{
              const withRatio = compData.filter(r => r.compression_ratio != null);
              if (withRatio.length) {{
                trace.x = [withRatio.reduce((s, r) => s + r.compression_ratio, 0) / withRatio.length * 100];
              }} else {{
                trace.x = [];
              }}
            }} else {{
              trace.x = [name];
            }}
            trace.y = [yAvg];
          }});
          Plotly.react(div, div.data, div.layout);
          delete div.__originalData;
        }}
      }});

      // Re-apply compressor filter if active
      if (window.__allCompressors && window.__selectedCompressors &&
          window.__selectedCompressors.length < window.__allCompressors.length) {{
        applyFilter();
      }}
    }}

    // Initialize on page load
    (function() {{
      function init() {{
        initDatasetFilter();
        if (Object.keys(window.__channelMap).length > 0) {{
          applyRowFilters();
        }}
      }}
      if (document.readyState === 'loading') {{
        document.addEventListener('DOMContentLoaded', init);
      }} else {{
        init();
      }}
    }})();
    {" ".join(plot_scripts)}
  </script>
</body>
</html>
"""


def _read_result_file(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df.columns = df.columns.str.strip()
    if "dataset" not in df.columns or "compressor" not in df.columns:
        raise ValueError(f"Missing required columns in {path}")
    return df


def load_input_data(input_path: Path, input_glob: str) -> tuple[pd.DataFrame, str]:
    if input_path.is_file():
        return _read_result_file(input_path), str(input_path)

    if input_path.is_dir():
        files = sorted(input_path.glob(input_glob))
        if not files:
            raise SystemExit(f"Error: no files matching '{input_glob}' in {input_path}")
        frames = [_read_result_file(path) for path in files]
        return pd.concat(frames, ignore_index=True), f"{input_path}/{input_glob}"

    raise SystemExit(f"Error: input path not found: {input_path}")


def discover_report_sources(
    input_path: Path, input_glob: str
) -> tuple[Path, list[Path]]:
    if input_path.is_file():
        return input_path.parent, [input_path]

    if not input_path.is_dir():
        raise SystemExit(f"Error: input path not found: {input_path}")

    if input_glob.strip():
        files = sorted(input_path.rglob(input_glob))
    else:
        files = sorted(
            {
                *input_path.rglob("results.csv"),
                *input_path.rglob("final_results.csv"),
            }
        )

    csv_files = [f for f in files if f.is_file()]
    if not csv_files:
        raise SystemExit(f"Error: no matching files found in {input_path}")

    return input_path, csv_files


def report_output_path(
    output_dir: Path, root_input_dir: Path, source_file: Path
) -> Path:
    relative = source_file.relative_to(root_input_dir)
    return (output_dir / relative).with_suffix(".html")


def build_index_html(
    root_input_dir: Path,
    output_dir: Path,
    pages: list[tuple[Path, Path]],
    compressor_pages: list[tuple[str, Path]] = [],
    signal_pages: list[tuple[str, Path]] = [],
) -> str:
    rows = []
    for source_file, report_path in pages:
        source_rel = source_file.relative_to(root_input_dir)
        report_rel = report_path.relative_to(output_dir).as_posix()
        rows.append(
            "<tr>"
            f"<td><code>{html.escape(str(source_rel))}</code></td>"
            f'<td><a href="{html.escape(report_rel)}">{html.escape(report_rel)}</a></td>'
            "</tr>"
        )

    signal_section = ""
    if signal_pages:
        signal_links = []
        for label, report_path in signal_pages:
            rel_path = report_path.relative_to(output_dir).as_posix()
            signal_links.append(
                f'<li><a href="{html.escape(rel_path)}">{html.escape(label)}</a></li>'
            )

        signal_section = f"""
  <h2>Signal family dashboards</h2>
  <div class="intro">
    Compare datasets within each signal family (ACC/PPG/ECG) across compressors.
  </div>
  <ul class="comp-list">
    {"".join(signal_links)}
  </ul>
"""

    comp_section = ""
    if compressor_pages:
        comp_links = []
        for comp_name, comp_path in compressor_pages:
            rel_path = comp_path.relative_to(output_dir).as_posix()
            comp_links.append(
                f'<li><a href="{html.escape(rel_path)}">{html.escape(comp_name)}</a></li>'
            )

        comp_section = f"""
  <h2>Compressor scaling</h2>
  <div class="intro">
    View how each compressor's performance correlates with input size and dataset type (std vs gap).
  </div>
  <ul class="comp-list">
    {"".join(comp_links)}
  </ul>
"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Benchmark reports index</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 24px; background: #fafafa; }}
    h1, h2 {{ margin-bottom: 10px; }}
    table {{
      width: 100%;
      border-collapse: collapse;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 24px;
    }}
    th, td {{
      border: 1px solid #ddd;
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }}
    th {{ background: #f3f3f3; }}
    code {{
      background: #f6f8fa;
      padding: 2px 4px;
      border-radius: 4px;
    }}
    .comp-list {{
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 10px;
      list-style: none;
      padding: 0;
    }}
    .comp-list li {{
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 6px;
      padding: 8px 12px;
    }}
    .intro {{ color: #555; margin: 0 0 12px 0; }}
    .comp-list a {{ text-decoration: none; font-weight: 600; color: #1f6feb; }}
    .comp-list a:hover {{ text-decoration: underline; }}
  </style>
</head>
<body>
  <h1>Benchmark reports</h1>
  
  <h2>Metric Reports</h2>
  <table>
    <thead>
      <tr>
        <th>Source CSV</th>
        <th>Report page</th>
      </tr>
    </thead>
    <tbody>
      {"".join(rows)}
    </tbody>
  </table>

  {signal_section}
  {comp_section}
</body>
</html>
"""


def serve_output_dir(output_dir: Path, port: int) -> None:
    handler = partial(http.server.SimpleHTTPRequestHandler, directory=str(output_dir))
    with socketserver.TCPServer(("", port), handler) as httpd:
        print(f"Serving {output_dir} at http://127.0.0.1:{port}/")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create a standalone HTML report with plots and tables for all benchmark metrics."
    )
    parser.add_argument(
        "input_path",
        type=str,
        help="Path to one CSV/TXT file or a directory containing benchmark result files",
    )
    parser.add_argument(
        "output_dir",
        nargs="?",
        default="full_report",
        help="Output directory (default: full_report)",
    )
    parser.add_argument(
        "--output-name",
        default="index.html",
        help="Output HTML file name (default: index.html)",
    )
    parser.add_argument(
        "--input-glob",
        default="",
        help="Optional recursive glob when input_path is a directory (default: results.csv and final_results.csv)",
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help="Start an HTTP server after generating all pages",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port used with --serve (default: 8000)",
    )
    args = parser.parse_args()

    input_path = Path(args.input_path).resolve()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    root_input_dir, source_files = discover_report_sources(input_path, args.input_glob)

    pages: list[tuple[Path, Path]] = []
    compressor_pages: list[tuple[str, Path]] = []
    signal_pages: list[tuple[str, Path]] = []

    for source_file in source_files:
        df = _read_result_file(source_file)
        df["dataset"] = df["dataset"].astype(str).str.strip()
        df["compressor"] = df["compressor"].astype(str).str.strip()
        df = infer_missing_type_and_size(df)

        output_path = report_output_path(output_dir, root_input_dir, source_file)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        source_label = str(source_file.relative_to(root_input_dir))

        df_for_report = df
        page_title = "Benchmark full report"
        page_heading = "Benchmark full report"
        intro_html = ""
        dataset_label_fn = None

        if source_file.name == "final_results.csv" and {
            "dataset_type",
            "dataset_size",
        } <= set(df.columns):
            df_for_report = aggregate_full_report_by_type_and_size(df)
            intro_html = (
                '<div class="intro">'
                "Datasets are aggregated by <code>type</code> and <code>size</code> "
                "(std / gap / gap shifted), showing the mean across all dataset bases.</div>"
            )
            dataset_label_fn = format_type_size_group_label

        output_path.write_text(
            build_report_html(
                df_for_report,
                source_label,
                page_title=page_title,
                page_heading=page_heading,
                intro_html=intro_html,
                dataset_label_fn=dataset_label_fn,
            ),
            encoding="utf-8",
        )
        pages.append((source_file, output_path))

        # Extra dashboards from final_results.csv
        if source_file.name == "final_results.csv" and "dataset_size" in df.columns:
            # Signal family dashboards (ACC/PPG/ECG)
            parsed = df["dataset"].astype(str).apply(parse_signal_dataset)
            df_signals = df.copy()
            df_signals["_signal_family"] = parsed.apply(
                lambda x: x["family"] if isinstance(x, dict) and "family" in x else ""
            )
            df_signals = df_signals[df_signals["_signal_family"] != ""]

            if not df_signals.empty:
                signal_report_dir = output_path.parent / "signals"
                signal_report_dir.mkdir(parents=True, exist_ok=True)

                families_present = sorted(df_signals["_signal_family"].unique())
                preferred = ["acc", "ppg", "ecg"]
                family_order = [f for f in preferred if f in families_present] + [
                    f for f in families_present if f not in preferred
                ]

                for fam in family_order:
                    fam_df = df_signals[df_signals["_signal_family"] == fam].drop(
                        columns=["_signal_family"]
                    )
                    if fam_df.empty:
                        continue

                    unique_datasets = fam_df["dataset"].drop_duplicates()

                    base_labels = unique_datasets.map(format_signal_dataset_label)
                    if base_labels.duplicated().any():
                        loc_labels = unique_datasets.map(
                            lambda d: (
                                f"{(parse_signal_dataset(d) or {}).get('location', '')} "
                                f"{format_signal_dataset_label(d)}"
                            ).strip()
                        )
                        if loc_labels.duplicated().any():
                            label_fn = lambda d: str(d)
                        else:
                            label_fn = lambda d: (
                                f"{(parse_signal_dataset(d) or {}).get('location', '')} "
                                f"{format_signal_dataset_label(d)}"
                            ).strip()
                    else:
                        label_fn = format_signal_dataset_label

                    page_title = f"Signal family dashboard: {fam.upper()}"
                    page_heading = f"Signal family dashboard: {fam.upper()}"
                    intro_html = (
                        '<div class="intro">'
                        "Dataset labels are shown as: <code>family channel type size</code> "
                        "(e.g. <code>acc x std 512</code>).</div>"
                    )

                    report_html = build_report_html(
                        fam_df,
                        source_label,
                        page_title=page_title,
                        page_heading=page_heading,
                        intro_html=intro_html,
                        dataset_label_fn=label_fn,
                        dataset_sort_key_fn=signal_dataset_sort_key,
                    )
                    out_path = signal_report_dir / f"{fam.lower()}.html"
                    out_path.write_text(report_html, encoding="utf-8")

                    display = fam.upper()
                    if fam.lower() == "acc":
                        display = "ACC (x/y/z)"
                    elif fam.lower() == "ppg":
                        display = "PPG (r/g/ir)"
                    elif fam.lower() == "ecg":
                        display = "ECG"

                    signal_pages.append((display, out_path))

            # Per-compressor scaling reports
            comp_report_dir = output_path.parent / "compressors"
            comp_report_dir.mkdir(parents=True, exist_ok=True)

            # Identify metrics for scaling
            excluded_metrics = {
                "num_values",
                "original_size",
                "dataset_size",
                "memory_usage",
            }
            numeric_metrics = [
                c
                for c in df.select_dtypes(include="number").columns
                if c not in excluded_metrics
            ]

            for compressor in sorted(df["compressor"].unique()):
                comp_report_content = build_compressor_scaling_report_html(
                    compressor, df, numeric_metrics
                )
                if comp_report_content:
                    comp_path = comp_report_dir / f"{compressor.lower()}.html"
                    comp_path.write_text(comp_report_content, encoding="utf-8")
                    compressor_pages.append((rename_compressor(compressor), comp_path))

    if input_path.is_file():
        index_path = output_dir / args.output_name
        single_page = pages[0][1]
        if single_page != index_path:
            index_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="0; url={html.escape(single_page.name)}" />
  <title>Redirecting...</title>
</head>
<body>
  Redirecting to <a href="{html.escape(single_page.name)}">{html.escape(single_page.name)}</a>
</body>
</html>
"""
            index_path.write_text(index_html, encoding="utf-8")
    else:
        index_path = output_dir / args.output_name
        index_path.write_text(
            build_index_html(
                root_input_dir,
                output_dir,
                pages,
                compressor_pages,
                signal_pages,
            ),
            encoding="utf-8",
        )

    print(index_path)

    if args.serve:
        serve_output_dir(output_dir, args.port)


if __name__ == "__main__":
    main()
