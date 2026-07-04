#!/bin/bash

set -euo pipefail

ROOT_DIR="${1:-benchmark_results}"
PORT=${PORT:-8000}
if [ ! -d "$ROOT_DIR" ]; then
  echo "Error: directory '$ROOT_DIR' not found."
  exit 1
fi

mapfile -t TARGET_DIRS < <(
  find "$ROOT_DIR" -type f -name '*.txt' -printf '%h\n' | sort -u
)

if [ ${#TARGET_DIRS[@]} -eq 0 ]; then
  echo "No .txt benchmark outputs found under '$ROOT_DIR'."
  exit 0
fi

for dir in "${TARGET_DIRS[@]}"; do
  echo "Merging results in: $dir"
  python3 scripts/merge_results.py "$dir" &
done
wait

echo "Building final merged results..."
python3 scripts/final_results.py "$ROOT_DIR"

echo "Generating and serving HTML report..."
python3 scripts/generate_full_html_report.py "$ROOT_DIR" --serve --port $PORT
