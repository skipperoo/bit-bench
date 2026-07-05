# ==========================================
# Stage 1: Build the Squash library
# ==========================================
FROM gcc:13 AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    wget \
    bzip2 \
    ninja-build \
    ragel \
    doxygen \
    valac \
    libglib2.0-dev \
    libglib2.0-dev \
    && rm -rf /var/lib/apt/lists/* 

WORKDIR /usr/src 
#/squash
RUN wget https://github.com/quixdb/squash/releases/download/v0.7.0/squash-0.7.0.tar.bz2 \
    && tar -xjf squash-0.7.0.tar.bz2 \
    && rm squash-0.7.0.tar.bz2 
# RUN git clone https://github.com/quixdb/squash.git . 
WORKDIR /usr/src/squash-0.7.0 
RUN mkdir build && cd build \
    && cmake -G Ninja \
       -DCMAKE_BUILD_TYPE=Release \
       -DCMAKE_INSTALL_PREFIX=/usr/local \
       .. \
    && ninja \
    && ninja install 


FROM gcc:13 AS cpp-build 
COPY --from=builder /usr/local/lib /usr/local/lib
COPY --from=builder /usr/local/include /usr/local/include
COPY --from=builder /usr/local/bin /usr/local/bin

# Update the dynamic linker run-time bindings
RUN ldconfig

WORKDIR /src 
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates cmake && rm -rf /var/lib/apt/lists/* 
COPY compression/ ./compression/ 

RUN cd compression && cmake -B build -DCMAKE_BUILD_TYPE=Release -DNEATS_WITH_SQUASH=OFF 
RUN cd compression && make -j$(nproc) -C build LosslessBenchmarkFull 

RUN mkdir -p /artifacts/bin && \
    cp compression/build/LosslessBenchmarkFull /artifacts/bin/ && \
    echo "Binary built"

# Stage 2: Build Go backend
FROM golang:1.26-alpine AS go-build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./ 
RUN go mod download 
COPY backend/ . 
RUN CGO_ENABLED=0 go build -o /out/bitbench ./cmd/bitbench-backend 

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        libstdc++6 \
        libgomp1 \
        libglib2.0-0 \
        libsnappy1v5 \
        libbrotli1 \
        && rm -rf /var/lib/apt/lists/*
COPY --from=cpp-build /usr/local/lib/ /usr/local/lib/
RUN ldconfig
WORKDIR /app

COPY --from=go-build /out/bitbench /app/bitbench
COPY --from=cpp-build /artifacts/bin/ /app/bin/
# ENV LD_LIBRARY_PATH=/app/bin/lib
EXPOSE 8080
CMD ["/app/bitbench"]
