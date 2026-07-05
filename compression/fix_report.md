# Compression Benchmark Fix Report

## Summary

Merged `gzip_1`, `gzip_6`, `gzip_9` into a single `gzip` compressor with tunable level via `=LEVEL` syntax in the `-c` argument. Extended the same mechanism to `bzip3` (block size from level) and all Squash-based dictionary compressors (lz4, zstd, brotli, xz, bzip2). Applied changes to both `lossless_benchmark.cpp` and `memory_harness.cpp`.

## Changes Made

### 1. `compression/benchmark/lossless_benchmark.cpp`

**New `=LEVEL` syntax in `-c`:**
- Compressor entries may include an optional `=LEVEL` suffix: `-c gzip=6,bzip3=9,lz4=3`
- Added `parse_compressor_name()` helper to split `name=LEVEL` pairs
- Added `default_level = 6` constant for entries without explicit level
- When no `=LEVEL` is specified (e.g., just `gzip`), level defaults to 6

**Default compressor list:**
- Removed `gzip_1`, `gzip_6`, `gzip_9` — replaced with single `gzip`

**GZip benchmark function (`benchmark_gzip`):**
- Signature changed from `(compressor_name, ..., block_size)` to `(compressor_name, ..., level, block_size)`
- Level is now passed directly instead of being parsed from the compressor name
- Result compressor name is always `"gzip"` (no more `gzip_1/gzip_6/gzip_9`)

**BZip3 benchmark function (`benchmark_bzip3`):**
- Signature changed from `(compressor_name, ..., block_size)` to `(compressor_name, ..., level, block_size)`
- Block size now computed as `level * 65536` instead of `max(65536, block_size * sizeof(T))`
- Level 1 = 64KB, Level 9 = 576KB (library clamps to minimum 65536 internally)

**Squash benchmark function (`benchmark_squash`):**
- Already accepted `int64_t level` parameter; no signature change needed
- Level is now passed down from `-c` parsing instead of defaulting to `-1`
- Affected compressors: lz4, zstd, brotli, xz, bzip2 (snappy has no level)

**Routing and execution sections:**
- All three phases (raw, shifted, double) now extract `base_name` (without `=LEVEL`) from each compressor entry before routing
- Raw phase: `comp_name` is used to detect `gzip` (was `gzip_` prefix match), `bzip3`, and Squash compressors
- Level extracted via `parse_level()` helper and passed to gzip/bzip3/squash calls
- Print usage updated to show `gzip` instead of `gzip_1,gzip_6,gzip_9`

### 2. `compression/benchmark/memory_harness.cpp`

**`run_gzip`:**
- Signature changed from `(compressor_name, data, block_size)` to `(data, block_size, level)`
- Level passed as direct parameter instead of parsed from compressor name

**`run_bzip3`:**
- Signature changed from `(data, block_size)` to `(data, block_size, level)`
- Block size computed as `level * 65536` (same mapping as `lossless_benchmark.cpp`)

**`run_squash`:**
- Added `int level = -1` parameter
- Creates `SquashOptions` with level when level is not -1
- Uses `squash_codec_compress_with_options()` instead of `squash_codec_compress()`
- Properly cleans up `SquashOptions` after compression

**Main function:**
- Added `base_name` / `level` extraction from compressor name with `=LEVEL` suffix
- All routing decisions use `base_name` instead of `compressor_name`
- `gzip` detection changed from `compressor_name.find("gzip_") == 0` to `base_name == "gzip"`
- Level passed to `run_gzip`, `run_bzip3`, and `run_squash`

### 3. `backend/internal/compressor/registry.go`

- Replaced `gzip_1`, `gzip_6`, `gzip_9` with single `gzip` having a `level` option (1-9, default 6, step 1)
- Added `level` option to `bzip3` (1-9, default 6, step 1)

### 4. `backend/internal/worker/exec.go`

- `mapCompressorName()` now appends `=LEVEL` suffix when a compressor has a non-default level option
- Example: `gzip` with `{level: 3}` produces `gzip=3`
- Default level 6 is not appended (compressor name stays as-is)
- PForDelta codec mapping still works correctly

### 5. Test files

- `registry_test.go`: Updated expected compressors list (`gzip` replaces `gzip_1/gzip_6/gzip_9`); replaced `TestGZipHasNoOptions` with `TestGZipHasLevelOption`; added `TestBzip3HasLevelOption`; removed `bzip3` from empty-options list
- `parser_test.go`: Changed all `gzip_6` references to `gzip`; added `TestBuildCompressorListLevel` test for `=LEVEL` syntax

## CLI Examples

```
# Before (old syntax):
./LosslessBenchmark -c gzip_1,gzip_6,gzip_9,bzip3

# After (new syntax):
./LosslessBenchmark -c gzip=1,gzip=6,gzip=9     # All three levels via -c
./LosslessBenchmark -c gzip=6,bzip3=9,gorilla   # Mixed with non-level compressors
./LosslessBenchmark -c gzip,bzip3                # Default level 6 for both
./LosslessBenchmark -c lz4=3,zstd=5,brotli=4    # Squash compressors with level
```

## Verification

- `gzip=6` produces output with compressor name `gzip` (not `gzip_6`)
- `bzip3=9` produces output with compressor name `bzip3`
- Default level 6 is used when no `=LEVEL` specified
- Both `LosslessBenchmark` (without Squash) and `LosslessBenchmarkFull` (with Squash) compile and run correctly
- `gzip=3` uses level 3 (different compression ratio vs default 6)
- All Go tests pass
