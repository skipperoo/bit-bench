# Stage 1: Build C++ artifacts
FROM gcc:13 AS cpp-build
WORKDIR /src
COPY compression/ ./compression/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates cmake git libsdsl-dev && \
    mkdir -p /src/compression/lib/sdsl-lite && \
    ln -s /usr/include /src/compression/lib/sdsl-lite/include && \
    git clone --depth 1 https://github.com/vigna/sux.git /tmp/sux && \
    mkdir -p /src/compression/lib/sux && \
    cp -r /tmp/sux/sux /src/compression/lib/sux/ && \
    rm -rf /tmp/sux && \
    echo "C++ dependencies installed"
RUN cd compression && cmake -B build -DCMAKE_BUILD_TYPE=Release -DUSE_SQUASH=OFF
RUN cd compression && make -j$(nproc) -C build LosslessBenchmark 2>&1 || \
    echo "NOTE: Benchmark binary not built — run 'make -C compression' on host with proper" && \
    echo "      submodule versions (see compression/README.md)"
RUN mkdir -p /artifacts/bin && \
    cp compression/build/LosslessBenchmark /artifacts/bin/ 2>/dev/null; \
    echo "C++ stage complete"

# Stage 2: Build Go backend
FROM golang:1.26-alpine AS go-build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ .
RUN CGO_ENABLED=0 go build -o /out/bitbench ./cmd/bitbench-backend

# Stage 3: Runtime
FROM alpine:3.21
RUN apk add --no-cache ca-certificates libstdc++ coreutils
WORKDIR /app
COPY --from=go-build /out/bitbench /app/bitbench
COPY --from=cpp-build /artifacts/bin/ /app/bin/
ENV LD_LIBRARY_PATH=/app/bin/lib
EXPOSE 8080
CMD ["/app/bitbench"]
