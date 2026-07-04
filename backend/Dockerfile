# Stage 1: Build C++ artifacts
FROM gcc:13 AS cpp-build
WORKDIR /src
COPY compression/ ./compression/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates cmake

# Build LosslessBenchmark (no Squash needed for basic operation)
RUN cd compression && cmake -B build -DCMAKE_BUILD_TYPE=Release -DNEATS_WITH_SQUASH=OFF
RUN cd compression && make -j$(nproc) -C build LosslessBenchmark

RUN mkdir -p /artifacts/bin && \
    cp compression/build/LosslessBenchmark /artifacts/bin/ && \
    echo "Binary built: $(ls /artifacts/bin/)"

# Stage 2: Build Go backend
FROM golang:1.26-alpine AS go-build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ .
RUN CGO_ENABLED=0 go build -o /out/bitbench ./cmd/bitbench-backend

# Stage 3: Runtime (Debian, not Alpine — C++ binary links against glibc)
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=go-build /out/bitbench /app/bitbench
COPY --from=cpp-build /artifacts/bin/ /app/bin/
ENV LD_LIBRARY_PATH=/app/bin/lib
EXPOSE 8080
CMD ["/app/bitbench"]
