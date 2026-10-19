# User-provided compressors

BitBench can run compressor implementations uploaded by users. A package is a
`.zip` archive that is validated, built **offline** on the server, and then
executed in a sandboxed container for every benchmark that selects it.

- **Who can upload:** `admin`, `professor` and `phd`.
- **Who can use:** every user sees the built-in compressors plus the ready
  packages of their own group. `admin` sees every package.
- **Re-uploading** a package with the same name replaces your own package.
  Other users cannot take an existing name, and names cannot collide with
  built-in compressors.
- Build progress, errors and build logs are shown on the **Compressors** page.

## Package structure

```
package.zip
├── spec.yaml            # required, at the archive root
├── Makefile             # optional, compiled languages
├── requirements.txt     # optional, Python (dependencies must be vendored)
├── vendor/              # optional, vendored Python dependencies
└── src/                 # your sources (any layout)
```

The archive must not contain symlinks, absolute paths, or `..` entries.

## spec.yaml

```yaml
name: my_codec              # required: [a-z0-9_]{1,64}, unique, no built-in collision
version: "1.0.0"            # required
description: My codec       # optional
language: cpp               # optional: c | cpp | python | go | rust | other
platform: linux/arm64       # optional: linux/amd64 or linux/arm64 (default: host platform)
entrypoint: ./codec         # required: command executed from the package root
workers: 1                  # optional: CPU slots needed (default 1)
build:                      # optional; "make" is used when a Makefile exists
  command: make -j2         # executed as /bin/sh -c inside the sandbox
  timeout_seconds: 600      # default: BUILD_TIMEOUT_SECONDS
options:                    # optional; same schema as the built-in compressors
  mode:
    type: select
    options: [fast, optimal]
    default: fast
  block_size:
    type: number
    min: 1
    max: 9
    default: 6
    step: 1
  verify:
    type: boolean
    default: true
```

Option fields follow the compressor-options widget schema:

| Type | Required keys | UI rendering |
|:--|:--|:--|
| `number` | `min`, `max`, `default`, optional `step` | slider when `(max-min)/step <= 20`, otherwise number input |
| `boolean` | `default` | switch |
| `select` | `options`, `default` | dropdown |

## Target platform and emulation

`platform` declares the CPU architecture the package is built and run on. It
accepts `linux/amd64` and `linux/arm64` (the `arm64/v8` variant is normalized);
leaving it out means "the platform of the benchmark host" — the common case.

When `platform` differs from the host platform, the container runs through
**binfmt/QEMU emulation**. Consequences:

- **Throughput, latency and random-access metrics are distorted** and must not
  be compared directly with native runs. Compression ratio, memory and
  reconstruction results remain trustworthy.
- **Builds are much slower**: `make -j` runs emulated. Raise
  `build.timeout_seconds` if needed; the package build itself also costs
  upload time when the file is large.
- The platform is applied to **both** the offline build container and the
  benchmark run container, so the produced executable matches the run
  environment.

Whenever a package that targets a foreign platform is selected, the upload
page shows an amber **"CPU emulation"** warning with the affected packages, and
each configured instance carries an `arm64 emulated` badge. The results,
benchmark-detail and compare pages repeat the warning because the target
platform is stored with each benchmark, and the Compressors page lists the
platform of every package.

### Making a foreign platform available on the host

The platform must be runnable before a package for it can be uploaded;
otherwise the upload is rejected with a clear error. Two prerequisites:

1. **A runner image for the target platform.** The compose stack builds
   `bitbench-runner:amd64` and `bitbench-runner:arm64`:

   ```bash
   docker compose build runner-amd64 runner-arm64
   ```

   Without compose, build one manually (requires buildx plus binfmt, see
   below):

   ```bash
   docker buildx build --platform linux/arm64 --load -t bitbench-runner:arm64 runner/
   ```

   The backend reads the image tags from `RUNNER_IMAGE_AMD64` and
   `RUNNER_IMAGE_ARM64` (defaults `bitbench-runner:amd64` and
   `bitbench-runner:arm64`).

2. **Emulation (binfmt/QEMU) for the target architecture.** Docker Desktop
   includes it; on plain Linux hosts register it once:

   ```bash
   docker run --privileged --rm tonistiigi/binfmt --install arm64   # or: --install all
   ```

   The backend probes a foreign platform with a one-off `/bin/true` container
   on the first package upload and caches the result for the running process.

## Invocation contract

For every `.bin` file and every selected compressor, the platform runs:

```
<entrypoint> -o <out.csv> --<option>=<value>... --options <options.json> <input.bin>
```

- Individual option flags are always passed; the JSON file is always passed too.
  **If both are present, the JSON file wins.** Parse the JSON when it exists,
  fall back to the flags otherwise.
- `<input.bin>` uses the standard sequence format: an 8-byte header
  (`uint64 N` + `N x int64`) or a 16-byte header (`uint64 N` +
  `uint64 decimals` + `N x int64`). Detect the format from the file size:
  the 16-byte format matches `16 + 8N`, the 8-byte format matches `8 + 8N`.
- Exit code `0` means success; anything else fails the benchmark (the tail of
  stdout/stderr is stored on the benchmark).

## Output format

Write a CSV to the `-o` path with exactly this header:

```
compressor,dataset,num_values,original_size,memory_usage,uncompressed_bits,compressed_bits,compression_ratio,compression_throughput_mbs,decompression_throughput_mbs,random_access_ns,random_access_mbs
```

- `compressor`: the package `name` (the platform normalizes it anyway).
- `dataset`: ignored by the platform; the benchmark label is used instead.
- Required metrics: `num_values`, `original_size`, `uncompressed_bits`,
  `compressed_bits`, `compression_ratio`, `compression_throughput_mbs`,
  `decompression_throughput_mbs`.
- Optional metrics: `memory_usage`, `random_access_ns`, `random_access_mbs`,
  and any `range_query_<N>` columns. **Leave a cell empty to store `NULL`
  instead of a misleading zero** (the platform does not run its Massif
  harness on user programs).
- Throughputs are MiB/s of input data: `(bytes / 1048576) / seconds`.

Example row:

```
my_codec,example,1000,8000,,64000,8000,0.125000,532.891,761.341,,
```

## Builds run offline

The build runs once, when you upload the package, inside the runner image
(Debian with Python 3 + pip, GCC/G++, Go, and Rust). The build has **no
network access**, so all dependencies must be vendored:

### Python

```bash
pip install --target vendor -r requirements.txt
```

Then reference them from the entrypoint:

```yaml
entrypoint: PYTHONPATH=vendor python3 src/main.py
```

### C / C++

Link third-party libraries statically or ship prebuilt static archives inside
the package and link them from your `Makefile`. The sandbox only provides the
compilers and the standard system runtime libraries.

Compile for the benchmark host with `-march=native` (or `-C target-cpu=native`
for Rust). Before emitting specific SIMD instructions (AVX2, AVX-512, ...),
check the instruction sets actually available on the **Status** page: the CPU
section lists the detected extensions (AVX2, AVX-512, FMA, ...).

> These flags apply to the **target platform**: with `platform: linux/arm64`
> on an x86 host, `-march=native` compiles for the emulated arm64 CPU, not for
> the physical host CPU.

### Go

```bash
go mod vendor
```

```make
codec: src/main.go go.mod
	go build -mod=vendor -o codec ./src
```

### Rust

```bash
cargo vendor vendor/
```

Point Cargo at the vendored directory via `.cargo/config.toml` in the package:

```toml
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "vendor"
```

```make
codec: src/main.rs Cargo.toml
	cargo build --offline --release
	cp target/release/codec codec
```

## Workers and resource limits

- `workers` declares how many CPU slots the compressor needs. Every run of the
  compressor costs that many units from the server's single worker budget
  (`MAX_PARALLELISM`, which defaults to the allocatable CPU cores and is shared
  fairly between competing benchmarks). If `workers` exceeds the budget the
  upload is rejected.
- The container is started with `--cpus=<workers>`. **If the process exceeds
  its declared quota** (cgroup throttling beyond `max(2s, 5% of runtime)`),
  it is killed and the benchmark fails.
- Containers run with no network, as a non-root user, with a read-only root
  filesystem, and with memory and pid limits (`RUNNER_MEMORY_MB`,
  `RUNNER_PIDS_LIMIT`).

## Limits and validation

| Limit | Value |
|:--|:--|
| Package size | `MAX_PACKAGE_SIZE_MB` (default 50 MB) |
| Uncompressed archive | 20x the package size cap |
| Files in archive | 5000 |
| Names | unique, `[a-z0-9_]{1,64}`, no built-in collision |
| Entrypoint | must exist and be executable after the build |

## Examples

Complete example packages for every supported language live in
[`examples/user-compressors/`](../examples/user-compressors):

| Language | Path |
|:--|:--|
| Python | `examples/user-compressors/python` |
| C | `examples/user-compressors/c` |
| C++ | `examples/user-compressors/cpp` |
| Go | `examples/user-compressors/go` |
| Rust | `examples/user-compressors/rust` |

Each example implements the same delta + zigzag varint codec, exposes `mode`
and `verify` options, and handles both `.bin` header formats.
