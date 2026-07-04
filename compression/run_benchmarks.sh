#!/bin/bash

# Check if input directory is provided
if [ $# -eq 0 ]; then
    echo "Usage: $0 <directory_with_bin_files>"
    exit 1
fi

INPUT_DIR="$1"
OUTPUT_DIR="${OUTPUT_DIR:-benchmark_results}"
PARALLELISM="${PARALLELISM:-1}"
BENCH_TIMEOUT_SECONDS="${BENCH_TIMEOUT_SECONDS:-0}"

if ! [[ "$PARALLELISM" =~ ^[1-9][0-9]*$ ]]; then
    echo "Error: PARALLELISM must be a positive integer (got '$PARALLELISM')."
    exit 1
fi
if ! [[ "$BENCH_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
    echo "Error: BENCH_TIMEOUT_SECONDS must be a non-negative integer (got '$BENCH_TIMEOUT_SECONDS')."
    exit 1
fi

# Locate the benchmark executable
if [ -f "./build/LosslessBenchmarkFull" ]; then
    BENCH_EXE="./build/LosslessBenchmarkFull"
    echo "Using: LosslessBenchmarkFull (with Squash support)"

    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    LIB_DIR="$SCRIPT_DIR/build/lib"

    if [ -d "$LIB_DIR" ]; then
        echo "Using bundled Squash libraries from: $LIB_DIR"
        export LD_LIBRARY_PATH="$LIB_DIR:$LD_LIBRARY_PATH"
    else
        echo "WARNING: Bundled 'lib' directory not found at $LIB_DIR"
        echo "If Squash is not installed system-wide, the benchmark will fail."
        echo "Please ensure you copied the 'build/lib' directory along with the executable."
    fi
elif [ -f "./build/LosslessBenchmark" ]; then
    BENCH_EXE="./build/LosslessBenchmark"
    echo "Using: LosslessBenchmark (Minimal)"
else
    echo "Error: Could not find 'LosslessBenchmark' or 'LosslessBenchmarkFull' in ./build/"
    echo "Please build the project first."
    exit 1
fi

# Extract list of available compressors from the benchmark's help output
ALL_COMPRESSORS_STR=$("$BENCH_EXE" -h 2>&1 | grep "Available:" | sed 's/.*Available: //')
if [ -z "$ALL_COMPRESSORS_STR" ]; then
    echo "Error: Could not determine available compressors from '$BENCH_EXE -h'"
    exit 1
fi
echo "Available compressors: $ALL_COMPRESSORS_STR"

mkdir -p "$OUTPUT_DIR"

shopt -s nullglob
FILES=("$INPUT_DIR"/*.bin)
shopt -u nullglob

if [ ${#FILES[@]} -eq 0 ]; then
    echo "No .bin files found in $INPUT_DIR"
    exit 0
fi

SKIP_LOG="$OUTPUT_DIR/skipped_timeout_files.log"
: > "$SKIP_LOG"
CHECKPOINT_LOG="$OUTPUT_DIR/skipped_checkpoint_files.log"
: > "$CHECKPOINT_LOG"

if ! printf '%s\0' "${FILES[@]}" | xargs -0 -n 1 -P "$PARALLELISM" bash -c '
    output_dir="$1"
    bench_exe="$2"
    timeout_seconds="$3"
    skip_log="$4"
    checkpoint_log="$5"
    all_compressors_str="$6"
    file="$7"

    basename=$(basename "$file")
    filename="${basename%.*}"
    output_file="$output_dir/${filename}.txt"

    IFS="," read -ra ALL_COMPRESSORS <<< "$all_compressors_str"

    if [ -f "$output_file" ]; then
        existing_compressors=$(tail -n +2 "$output_file" 2>/dev/null | cut -d, -f1 | tr '[:upper:]' '[:lower:]' | sort -u)

        missing_compressors=()
        for comp in "${ALL_COMPRESSORS[@]}"; do
            comp_lc=$(echo "$comp" | tr '[:upper:]' '[:lower:]')
            if ! echo "$existing_compressors" | grep -q "^$comp_lc"; then
                missing_compressors+=("$comp")
            fi
        done

        if [ ${#missing_compressors[@]} -eq 0 ]; then
            echo "Checkpoint hit, skipping completed result: $basename"
            printf "%s\n" "$file" >> "$checkpoint_log"
            exit 0
        fi

        printf -v missing_list '%s,' "${missing_compressors[@]}"
        missing_list="${missing_list%,}"
        echo "Partial checkpoint hit, running missing compressors for: $basename ($missing_list)"

        tmpfile=$(mktemp)
        if (( timeout_seconds > 0 )); then
            timeout "$timeout_seconds" "$bench_exe" -c "$missing_list" -o "$tmpfile" "$file"
            status=$?
            if [ "$status" -eq 124 ]; then
                echo "Timed out after ${timeout_seconds}s: $basename (partially skipped)"
                rm -f "$tmpfile"
                printf "%s\n" "$file" >> "$skip_log"
                exit 0
            fi
        else
            "$bench_exe" -c "$missing_list" -o "$tmpfile" "$file"
            status=$?
        fi

        if [ "$status" -ne 0 ]; then
            echo "Benchmark failed for: $basename (exit $status)"
            rm -f "$tmpfile"
            exit "$status"
        fi

        if [ -s "$tmpfile" ]; then
            tail -n +2 "$tmpfile" >> "$output_file"
        fi
        rm -f "$tmpfile"
    else
        echo "Running benchmark for: $basename"
        echo "Output saving to: $output_file"
        if (( timeout_seconds > 0 )); then
            timeout "$timeout_seconds" "$bench_exe" -o "$output_file" "$file"
            status=$?
            if [ "$status" -eq 124 ]; then
                echo "Timed out after ${timeout_seconds}s: $basename (skipping)"
                rm -f "$output_file"
                printf "%s\n" "$file" >> "$skip_log"
                exit 0
            fi
        else
            "$bench_exe" -o "$output_file" "$file"
            status=$?
        fi

        if [ "$status" -ne 0 ]; then
            echo "Benchmark failed for: $basename (exit $status)"
            rm -f "$output_file"
            exit "$status"
        fi
    fi
' _ "$OUTPUT_DIR" "$BENCH_EXE" "$BENCH_TIMEOUT_SECONDS" "$SKIP_LOG" "$CHECKPOINT_LOG" "$ALL_COMPRESSORS_STR"; then
    echo "Completed with errors for '$INPUT_DIR'."
    exit 1
fi

if [ -s "$SKIP_LOG" ]; then
    skipped_count=$(wc -l < "$SKIP_LOG")
    echo "Skipped $skipped_count timed-out file(s). See: $SKIP_LOG"
else
    rm -f "$SKIP_LOG"
fi

if [ -s "$CHECKPOINT_LOG" ]; then
    skipped_checkpoint_count=$(wc -l < "$CHECKPOINT_LOG")
    echo "Skipped $skipped_checkpoint_count file(s) with existing complete results. See: $CHECKPOINT_LOG"
else
    rm -f "$CHECKPOINT_LOG"
fi

echo "All benchmarks completed. Results stored in '$OUTPUT_DIR/'"
exit 0
