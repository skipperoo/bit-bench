#!/usr/bin/env python3

"""
Measure peak memory usage per compressor using Valgrind Massif.

Runs each compressor under Valgrind Massif by calling the MemoryHarness
binary with a specific compressor, and extracts peak memory per snapshot
(total = heap + heap-extra + stacks).

By default it also runs a matching baseline_* mode (same preprocessing, no
compression) and reports compressor_internal as (peak_after_ready - baseline_after_ready).
Use --no-baseline to disable.

Usage:
    python3 measure_memory_massif.py <benchmark_binary> <results_dir> <output_csv>

Example:
    python3 measure_memory_massif.py ./build/MemoryHarness benchmark_results/std/size_1536 memory.csv
"""

import argparse
import concurrent.futures
import csv
import os
import random
import subprocess
import sys
from collections import defaultdict
from pathlib import Path


def extract_peak_memory_from_massif(
    massif_out_file: str,
    *,
    require_ready_phase: bool,
    ready_marker_substr: str = "massif_phase_marker_begin",
    marker_bytes_to_subtract: int = 0,
) -> int:
    """Extract peak memory from a massif.out file.

    We use Massif's notion of "total" memory per snapshot:
      total = mem_heap_B + mem_heap_extra_B + mem_stacks_B

    If require_ready_phase=True, we only consider snapshots taken after
    MemoryHarness printed READY_FOR_COMPRESSION (detected via an allocation
    stack containing `ready_marker_substr`).
    """
    try:
        with open(massif_out_file, "r") as f:
            peak = None
            cur_heap = None
            cur_extra = 0
            cur_stacks = 0
            cur_has_marker = False

            def commit_current():
                nonlocal peak, cur_heap, cur_extra, cur_stacks, cur_has_marker
                if cur_heap is None:
                    return
                if require_ready_phase and not cur_has_marker:
                    return
                total = int(cur_heap) + int(cur_extra) + int(cur_stacks)
                if marker_bytes_to_subtract:
                    total = max(0, total - int(marker_bytes_to_subtract))
                peak = total if peak is None else max(peak, total)

            for raw_line in f:
                line = raw_line.strip()
                if line.startswith("snapshot="):
                    commit_current()
                    cur_heap = None
                    cur_extra = 0
                    cur_stacks = 0
                    cur_has_marker = False
                else:
                    if ready_marker_substr in line:
                        cur_has_marker = True
                    if line.startswith("mem_heap_B="):
                        cur_heap = int(line.split("=", 1)[1])
                    elif line.startswith("mem_heap_extra_B="):
                        cur_extra = int(line.split("=", 1)[1])
                    elif line.startswith("mem_stacks_B="):
                        cur_stacks = int(line.split("=", 1)[1])

            commit_current()
            return peak
    except FileNotFoundError:
        return None


def get_signal_dataset_from_path(file_path: str) -> str:
    """Extract signal dataset name from file path."""
    basename = Path(file_path).stem
    parts = basename.rsplit("_", 1)
    return parts[0] if len(parts) > 1 else basename


def get_data_format_for_compressor(compressor: str) -> str:
    """Mirror MemoryHarness' input representation selection.

    Returns one of: "shifted", "double", "raw".
    """
    c = (compressor or "").lower()

    if c in {"baseline_shifted", "baseline_double", "baseline_raw"}:
        return c.split("_", 1)[1]

    if c == "neats" or c == "dac" or ("_gef" in c) or c == "leco":
        return "shifted"

    if c in {"alp", "gorilla", "chimp", "chimp128", "tsxor", "elf", "camel", "falcon"}:
        return "double"

    return "raw"


def run_benchmark_with_massif(
    binary_path: str,
    compressor: str,
    input_file: str,
    massif_out_file: str,
    timeout: int = 600,
) -> dict:
    """
    Run benchmark binary under Valgrind Massif and return detailed memory stats.
    """
    try:
        # Remove old massif output if it exists
        if os.path.exists(massif_out_file):
            os.remove(massif_out_file)

        # Run under Valgrind Massif
        cmd = [
            "valgrind",
            "--tool=massif",
            "--detailed-freq=1",
            "--max-snapshots=100",
            f"--massif-out-file={massif_out_file}",
            binary_path,
            input_file,
            "-c",
            compressor.lower(),
        ]

        result = subprocess.run(cmd, timeout=timeout, capture_output=True, text=True)

        # Parse stdout for harness-specific info
        harness_stats = {}
        for line in result.stdout.splitlines():
            if ":" in line:
                key, val = line.split(":", 1)
                harness_stats[key.strip()] = val.strip()

        if result.returncode != 0:
            return None

        # Extract peak memory (Massif total = heap + heap-extra + stacks)
        # Prefer the peak after READY_FOR_COMPRESSION so startup/I/O doesn't dominate.
        marker_bytes = 64 * 1024
        peak_memory = extract_peak_memory_from_massif(
            massif_out_file,
            require_ready_phase=True,
            marker_bytes_to_subtract=marker_bytes,
        )
        if peak_memory is None:
            peak_memory = extract_peak_memory_from_massif(
                massif_out_file,
                require_ready_phase=False,
            )

        if peak_memory is None:
            return None

        input_buffer = int(harness_stats.get("input_buffer_bytes", 0))

        return {
            "peak_memory": peak_memory,
            "input_buffer": input_buffer,
        }

    except Exception:
        return None
    finally:
        # Clean up Massif output file
        if os.path.exists(massif_out_file):
            try:
                os.remove(massif_out_file)
            except:
                pass


def process_task(task):
    binary_path, compressor, signal, bin_file, massif_out, timeout = task
    stats = run_benchmark_with_massif(
        binary_path, compressor, str(bin_file), massif_out, timeout
    )
    return (compressor, signal, str(bin_file), stats)


def process_baseline_task(task):
    binary_path, baseline_compressor, data_format, bin_file, massif_out, timeout = task
    stats = run_benchmark_with_massif(
        binary_path, baseline_compressor, str(bin_file), massif_out, timeout
    )
    return (str(bin_file), data_format, stats)


def main():
    parser = argparse.ArgumentParser(
        description="Measure peak memory usage per compressor using Valgrind Massif"
    )
    parser.add_argument("binary", help="Path to MemoryHarness binary")
    parser.add_argument("results_dir", help="Directory containing result .txt files")
    parser.add_argument("output_csv", help="Output CSV file for memory results")
    parser.add_argument(
        "--timeout",
        type=int,
        default=600,
        help="Timeout per benchmark in seconds (default: 600)",
    )
    parser.add_argument(
        "--compressors", help="Comma-separated list of compressors to test"
    )
    parser.add_argument(
        "--samples",
        type=int,
        default=5,
        help="Number of random samples per signal (default: 5)",
    )
    parser.add_argument(
        "--parallelism",
        type=int,
        default=1,
        help="Number of parallel massif runs (default: 1)",
    )
    parser.add_argument(
        "--no-baseline",
        action="store_true",
        help="Disable baseline subtraction. If set, compressor_internal falls back to max(0, peak_memory - input_buffer).",
    )

    args = parser.parse_args()

    # Validate binary exists
    if not os.path.isfile(args.binary):
        print(f"Error: benchmark binary not found: {args.binary}", file=sys.stderr)
        return 1

    if not os.path.isdir(args.results_dir):
        print(f"Error: results_dir not found: {args.results_dir}", file=sys.stderr)
        return 1

    # Find all .txt result files in the directory
    all_txt = sorted(Path(args.results_dir).glob("*.txt"))
    result_files = [f for f in all_txt if not f.name.startswith(".")]

    if not result_files:
        print(f"Warning: No .txt files found in {args.results_dir}", file=sys.stderr)
        return 1

    # Extract compressor list
    compressors = set()
    if args.compressors:
        compressors = set(c.strip() for c in args.compressors.split(","))
    else:
        found_first = False
        for result_file in result_files:
            try:
                with open(result_file) as f:
                    header = f.readline()
                    if not header.strip():
                        continue
                    for line in f:
                        parts = line.split(",")
                        if len(parts) > 0:
                            comp_name = parts[0].strip()
                            if comp_name and comp_name != "compressor":
                                compressors.add(comp_name)
                    found_first = True
                    break
            except Exception:
                continue

        if not found_first:
            print(
                f"Error: Could not read any result files in {args.results_dir}",
                file=sys.stderr,
            )
            return 1

    if not compressors:
        print("Error: No compressors found", file=sys.stderr)
        return 1

    compressors = sorted(compressors)
    print(f"Found {len(compressors)} compressors.")

    # Map result files to their corresponding .bin input files
    samples = defaultdict(list)
    results_path = Path(args.results_dir)
    inferred_type = next(
        (p for p in results_path.parts if p in ["std", "gap", "gap_shifted"]), None
    )
    inferred_size = next((p for p in results_path.parts if p.startswith("size_")), None)

    for result_file in result_files:
        basename = result_file.stem
        signal_dataset = get_signal_dataset_from_path(basename)
        bin_filename = basename + ".bin"
        bin_file = None

        if inferred_type and inferred_size:
            candidate = Path("datasets") / inferred_type / inferred_size / bin_filename
            if candidate.exists():
                bin_file = candidate

        if not bin_file:
            for candidate in Path("datasets").rglob(bin_filename):
                if candidate.is_file():
                    bin_file = candidate
                    break

        if bin_file:
            samples[signal_dataset].append(bin_file)

    if not samples:
        print("Error: Could not find any .bin input files", file=sys.stderr)
        return 1

    # Check Selection of samples with fixed seed
    random.seed(42)
    selected_samples = {}
    for signal, files in samples.items():
        if len(files) <= args.samples:
            selected_samples[signal] = files
        else:
            selected_samples[signal] = random.sample(files, args.samples)

    # Check for checkpoint
    if os.path.exists(args.output_csv):
        try:
            with open(args.output_csv, "r") as f:
                reader = csv.DictReader(f)
                existing_rows = list(reader)

            existing_keys = set(
                (row["compressor"].lower(), row["dataset"]) for row in existing_rows
            )
            target_keys = set(
                (comp.lower(), signal)
                for signal in selected_samples.keys()
                for comp in compressors
            )

            if target_keys.issubset(existing_keys):
                print(
                    f"Checkpoint hit: {args.output_csv} already contains all {len(target_keys)} measurements. Skipping."
                )
                return 0
            else:
                missing = target_keys - existing_keys
                print(
                    f"Checkpoint incomplete: missing {len(missing)} measurements. Restarting from scratch."
                )
        except Exception as e:
            print(
                f"Warning: Could not read checkpoint file {args.output_csv}: {e}. Restarting."
            )

    print(
        f"Measuring {len(compressors)} compressors on {len(selected_samples)} signals with {args.samples} samples each (parallelism={args.parallelism})"
    )

    baseline_enabled = not args.no_baseline
    baseline_by_file_and_format = {}

    # Phase 0: Baselines (same input+preprocessing, no compression)
    if baseline_enabled:
        formats_needed = sorted(
            {get_data_format_for_compressor(c) for c in compressors}
        )
        baseline_keys = sorted(
            {
                (str(bin_file), fmt)
                for files in selected_samples.values()
                for bin_file in files
                for fmt in formats_needed
            }
        )
        baseline_tasks = []
        for idx, (bin_file_str, fmt) in enumerate(baseline_keys):
            baseline_comp = f"baseline_{fmt}"
            massif_out = f"/tmp/massif_{baseline_comp}_{idx}.out"
            baseline_tasks.append(
                (
                    args.binary,
                    baseline_comp,
                    fmt,
                    bin_file_str,
                    massif_out,
                    args.timeout,
                )
            )

        print(
            f"Running {len(baseline_tasks)} baseline Massif runs (formats={','.join(formats_needed)})"
        )

        with concurrent.futures.ProcessPoolExecutor(
            max_workers=args.parallelism
        ) as executor:
            future_to_task = {
                executor.submit(process_baseline_task, task): task
                for task in baseline_tasks
            }
            completed = 0
            total = len(baseline_tasks)

            for future in concurrent.futures.as_completed(future_to_task):
                bin_file_str, fmt, stats = future.result()
                if stats and stats.get("peak_memory") is not None:
                    baseline_by_file_and_format[(bin_file_str, fmt)] = stats

                completed += 1
                if completed % 10 == 0 or completed == total:
                    print(
                        f"Baseline progress: {completed}/{total} tasks completed...",
                        end="\r",
                    )
        print()

    # Phase 1: Compressor runs
    tasks = []
    for signal, files in selected_samples.items():
        for compressor in compressors:
            for i, bin_file in enumerate(files):
                massif_out = f"/tmp/massif_{compressor}_{signal}_{i}.out"
                tasks.append(
                    (
                        args.binary,
                        compressor,
                        signal,
                        bin_file,
                        massif_out,
                        args.timeout,
                    )
                )

    results_raw = defaultdict(lambda: defaultdict(list))
    warned_missing_baseline = False

    with concurrent.futures.ProcessPoolExecutor(
        max_workers=args.parallelism
    ) as executor:
        future_to_task = {executor.submit(process_task, task): task for task in tasks}

        completed = 0
        total = len(tasks)

        for future in concurrent.futures.as_completed(future_to_task):
            compressor, signal, bin_file_str, stats = future.result()
            if stats and stats.get("peak_memory") is not None:
                if baseline_enabled:
                    fmt = get_data_format_for_compressor(compressor)
                    base = baseline_by_file_and_format.get((bin_file_str, fmt))
                    if base and base.get("peak_memory") is not None:
                        # Prefer baseline's input buffer to keep it consistent.
                        if base.get("input_buffer") is not None:
                            stats["input_buffer"] = base["input_buffer"]
                        stats["compressor_internal"] = max(
                            0, stats["peak_memory"] - base["peak_memory"]
                        )
                    else:
                        if not warned_missing_baseline:
                            print(
                                "Warning: Missing baseline for some runs; falling back to peak-input for compressor_internal."
                            )
                            warned_missing_baseline = True
                        stats["compressor_internal"] = max(
                            0, stats["peak_memory"] - stats.get("input_buffer", 0)
                        )
                else:
                    stats["compressor_internal"] = max(
                        0, stats["peak_memory"] - stats.get("input_buffer", 0)
                    )

                results_raw[compressor][signal].append(stats)

            completed += 1
            if completed % 10 == 0 or completed == total:
                print(f"Progress: {completed}/{total} tasks completed...", end="\r")
    print()

    # Average results
    final_measurements = []
    for compressor in sorted(results_raw.keys()):
        for signal in sorted(results_raw[compressor].keys()):
            stats_list = results_raw[compressor][signal]
            if not stats_list:
                continue

            avg_peak = sum(s["peak_memory"] for s in stats_list) / len(stats_list)
            avg_buffer = sum(s["input_buffer"] for s in stats_list) / len(stats_list)
            avg_internal = sum(s["compressor_internal"] for s in stats_list) / len(
                stats_list
            )

            final_measurements.append(
                [compressor, signal, avg_peak, avg_buffer, avg_internal]
            )

    # Write to CSV
    with open(args.output_csv, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "compressor",
                "dataset",
                "memory_usage",
                "input_buffer",
                "compressor_internal",
            ]
        )
        writer.writerows(final_measurements)

    print(f"Wrote averaged memory measurements to: {args.output_csv}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
