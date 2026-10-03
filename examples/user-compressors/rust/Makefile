RUSTC ?= rustc
RUSTFLAGS ?= -O -C target-cpu=native --edition 2021

codec: src/main.rs
	$(RUSTC) $(RUSTFLAGS) -o codec src/main.rs

clean:
	rm -f codec
