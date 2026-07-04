#!/bin/bash

# Target dataset types
DATASET_TYPES=("std" "gap" "gap_shifted")
PARALLELISM="${PARALLELISM:-1}"
BENCH_TIMEOUT_SECONDS="${BENCH_TIMEOUT_SECONDS:-0}"
MASSIF_TIMEOUT_SECONDS="${MASSIF_TIMEOUT_SECONDS:-600}"

if ! [[ "$PARALLELISM" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: PARALLELISM must be a positive integer (got '$PARALLELISM')."
  exit 1
fi
if ! [[ "$BENCH_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "Error: BENCH_TIMEOUT_SECONDS must be a non-negative integer (got '$BENCH_TIMEOUT_SECONDS')."
  exit 1
fi
if ! [[ "$MASSIF_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: MASSIF_TIMEOUT_SECONDS must be a positive integer (got '$MASSIF_TIMEOUT_SECONDS')."
  exit 1
fi

mkdir -p benchmark_results

run_dataset() {
  local type="$1"
  local ds_dir="$2"
  local ds_name
  ds_name="$(basename "$ds_dir")"
  local result_target_dir="benchmark_results/$type/$ds_name"

  echo "===================================================="
  echo "Processing Dataset: $type / $ds_name"
  echo "===================================================="

  mkdir -p "$result_target_dir"

  if ! PARALLELISM="$PARALLELISM" BENCH_TIMEOUT_SECONDS="$BENCH_TIMEOUT_SECONDS" OUTPUT_DIR="$result_target_dir" ./run_benchmarks.sh "$ds_dir"; then
    return 1
  fi

  # Run Valgrind Massif-based memory profiling
  echo "===================================================="
  echo "Running Valgrind Massif memory profiling..."
  echo "===================================================="

  local build_dir="./build"
  local binary="$build_dir/MemoryHarness"

  if [ ! -f "$binary" ]; then
    echo "Warning: MemoryHarness binary not found at $binary, skipping Massif profiling"
  else
    if ! python3 scripts/measure_memory_massif.py "$binary" "$result_target_dir" "$result_target_dir/memory.csv" --timeout "$MASSIF_TIMEOUT_SECONDS" --parallelism "$PARALLELISM" --samples 5; then
      echo "Warning: Massif profiling failed for $ds_name, continuing..."
    fi
  fi
}

failed=0

for TYPE in "${DATASET_TYPES[@]}"; do
  BASE_DIR="datasets/$TYPE"

  if [ ! -d "$BASE_DIR" ]; then
    echo "Skipping $TYPE: Directory $BASE_DIR not found."
    continue
  fi

  for DS_DIR in "$BASE_DIR"/*/; do
    [ -d "$DS_DIR" ] || continue

    if ! run_dataset "$TYPE" "$DS_DIR"; then
      failed=1
    fi
  done
done

if ((failed != 0)); then
  echo "Completed with errors."
  exit 1
fi

echo "All benchmarks completed."
