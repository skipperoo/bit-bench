# BitBench package `nlms_cm` — see spec.yaml / docs/user-compressors.md.
CC      ?= cc
CFLAGS  ?= -O3 -std=c11 -Wall -Wextra

codec: src/main.c src/nlms_cm.c src/nlms_cm_tables.c src/nlms_cm.h src/compact_fallback.h
	$(CC) $(CFLAGS) -o $@ src/main.c src/nlms_cm.c src/nlms_cm_tables.c

selftest: src/selftest.c src/nlms_cm.c src/nlms_cm_tables.c src/nlms_cm.h
	$(CC) $(CFLAGS) -o $@ src/selftest.c src/nlms_cm.c src/nlms_cm_tables.c

clean:
	rm -f codec selftest

.PHONY: clean selftest
