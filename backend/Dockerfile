# Stage 1: Build C++ artifacts
FROM gcc:13 AS cpp-build
WORKDIR /src
COPY compression/ ./compression/
RUN cd compression && cmake -B build -DCMAKE_BUILD_TYPE=Release 2>/dev/null && \
    (make -j$(nproc) -C build 2>/dev/null || echo "C++ build optional, continuing")
RUN mkdir -p /artifacts/bin /artifacts/lib && \
    cp compression/build/LosslessBenchmark* /artifacts/bin/ 2>/dev/null || true && \
    cp -r compression/build/lib /artifacts/ 2>/dev/null || true

# Stage 2: Build Go backend (with dependency caching)
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
COPY --from=cpp-build /artifacts/lib/ /app/bin/lib 2>/dev/null || true
ENV LD_LIBRARY_PATH=/app/bin/lib
EXPOSE 8080
CMD ["/app/bitbench"]
