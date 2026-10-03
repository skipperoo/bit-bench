# Example compressor packages

Each directory is a complete, uploadable package for one supported language.
All five implement the same **delta + zigzag varint** codec and expose the same
options (`mode`: `delta`/`raw`, `verify`: boolean), so they can be compared
against each other and against the built-in compressors.

| Directory | Language | Build step |
|:--|:--|:--|
| `python/` | Python 3 | none |
| `c/` | C | `make` (gcc) |
| `cpp/` | C++ | `make` (g++) |
| `go/` | Go | `make` (go build) |
| `rust/` | Rust | `make` (rustc) |

To upload one, zip the **contents** of a directory (so `spec.yaml` is at the
archive root) and upload it from the **Compressors** page:

```bash
cd examples/user-compressors/python
zip -r /tmp/example_delta_py.zip .
```

See [`docs/user-compressors.md`](../../docs/user-compressors.md) for the full
package format, invocation contract, output CSV schema, vendoring rules and
resource limits.
