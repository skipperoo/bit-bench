# Example compressor packages

`basic-compressors/` holds one complete, uploadable package per supported
language. All five implement the same **delta + zigzag varint** codec and expose the same
options (`mode`: `delta`/`raw`, `verify`: boolean), so they can be compared
against each other and against the built-in compressors.

| Directory | Language | Build step |
|:--|:--|:--|
| `basic-compressors/python/` | Python 3 | none |
| `basic-compressors/c/` | C | `make` (gcc) |
| `basic-compressors/cpp/` | C++ | `make` (g++) |
| `basic-compressors/go/` | Go | `make` (go build) |
| `basic-compressors/rust/` | Rust | `make` (rustc) |

To upload one, zip the **contents** of a directory (so `spec.yaml` is at the
archive root) and upload it from the **Compressors** page:

```bash
cd examples/user-compressors/basic-compressors/python
zip -r /tmp/example_delta_py.zip .
```

`c-compressors/` holds C codecs from the thesis (Rice, range coding, Huffman,
PForDelta variants, RLE-GEF, NLMS context mixing), each with its own README.
They also report the optional memory columns `input_buffer` and
`compressor_internal`.

See [`docs/user-compressors.md`](../../docs/user-compressors.md) for the full
package format, invocation contract, output CSV schema, vendoring rules and
resource limits.
