# BitBench package `delta_huff` (Delta-Huff) — see spec.yaml / docs/user-compressors.md.
CC      ?= cc
CFLAGS  ?= -O3 -march=native -std=c11 -Wall -Wextra
LDLIBS  ?= -lm

codec: src/main.c src/huff_delta.c src/huff_delta.h
	$(CC) $(CFLAGS) -o $@ src/main.c src/huff_delta.c $(LDLIBS)

selftest: src/selftest.c src/huff_delta.c src/huff_delta.h
	$(CC) $(CFLAGS) -o $@ src/selftest.c src/huff_delta.c $(LDLIBS)

bench: src/bench_capture.c src/huff_delta.c src/huff_delta.h
	$(CC) $(CFLAGS) -o $@ src/bench_capture.c src/huff_delta.c $(LDLIBS)

clean:
	rm -f codec selftest bench

.PHONY: clean selftest bench
