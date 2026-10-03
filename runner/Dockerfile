# ==========================================
# BitBench compressor runner
# Sandbox image used to build and execute user-provided compressor packages.
# Both build and run phases are executed offline (--network none).
# ==========================================
FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        python3-pip \
        python3-venv \
        gcc \
        g++ \
        make \
        cmake \
        pkg-config \
        golang-go \
        rustc \
        cargo \
        && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 runner

ENV HOME=/tmp \
    TMPDIR=/tmp \
    GOCACHE=/tmp/go-build \
    GOMODCACHE=/tmp/go/pkg/mod \
    GOPATH=/tmp/go \
    CARGO_HOME=/tmp/cargo \
    RUSTUP_HOME=/tmp/rustup

WORKDIR /pkg
USER runner

CMD ["/bin/true"]
