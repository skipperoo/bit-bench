CC ?= gcc
CFLAGS ?= -O3 -march=native -Wall -Wextra

codec: src/main.c
	$(CC) $(CFLAGS) -o codec src/main.c

clean:
	rm -f codec
