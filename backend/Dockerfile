FROM gcc:13 AS cpp-build
WORKDIR /src
COPY compression/ ./compression/
RUN cd compression && cmake -B build -DCMAKE_BUILD_TYPE=Release && make -j$(nproc) -C build

FROM golang:1.26 AS go-build
WORKDIR /src
COPY backend/ ./backend/
COPY --from=cpp-build /src/compression/build/LosslessBenchmark* /tmp/cpp/
RUN cd backend && CGO_ENABLED=0 go build -o /out/bitbench ./cmd/bitbench-backend

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=go-build /out/bitbench /app/bitbench
COPY --from=cpp-build /src/compression/build/LosslessBenchmark* /app/bin/
COPY --from=cpp-build /src/compression/build/lib /app/bin/lib
ENV LD_LIBRARY_PATH=/app/bin/lib
CMD ["/app/bitbench"]
