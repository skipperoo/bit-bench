"""Shared helpers for writing BitBench standardized-dataset files.

A standardized dataset is a directory ``datasets/<dataset>/`` holding one
``<series>.bin`` per full recording, in the BitBench .bin format:

    uint64 N | uint64 decimals | N x int64 values     (little endian)

``decimals`` tells floating-point compressors how many decimal digits the
integers encode (value / 10**decimals); use 0 for plain integer data.
"""

from __future__ import annotations

import re
import struct
from pathlib import Path
from typing import Iterable, Optional

import numpy as np

_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_name(name: str) -> str:
    """Turn a label into a valid dataset/series name ([A-Za-z0-9._-], no '..')."""
    cleaned = _NAME_RE.sub("_", name.strip()).strip("._-")
    cleaned = cleaned.replace("..", "_")
    if not cleaned:
        raise ValueError(f"cannot derive a name from {name!r}")
    return cleaned[:100]


def write_series(path: Path, values: Iterable[int], decimals: int = 0) -> int:
    """Write one series with the standard 16-byte header; returns N."""
    data = np.asarray(values)
    if data.ndim != 1:
        raise ValueError("a series must be one-dimensional")
    if data.size == 0:
        raise ValueError(f"{path}: refusing to write an empty series")
    if not np.issubdtype(data.dtype, np.integer):
        raise ValueError(f"{path}: values must be integers (scale floats with --decimals)")
    data = data.astype("<i8", copy=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(struct.pack("<QQ", data.size, decimals))
        f.write(data.tobytes())
    return int(data.size)


def scale_to_int(values: np.ndarray, decimals: int) -> np.ndarray:
    """Scale floats by 10**decimals and round to int64 (rejects NaN/inf)."""
    arr = np.asarray(values, dtype=np.float64)
    if not np.all(np.isfinite(arr)):
        raise ValueError("series contains NaN or infinite values; drop or fill them first")
    return np.rint(arr * (10 ** decimals)).astype(np.int64)


def write_metadata(dataset_dir: Path, description: str, source: Optional[str] = None) -> None:
    """Write the optional dataset.yaml shown in the BitBench UI."""
    dataset_dir.mkdir(parents=True, exist_ok=True)
    lines = [f"description: {_yaml_str(description)}"]
    if source:
        lines.append(f"source: {_yaml_str(source)}")
    (dataset_dir / "dataset.yaml").write_text("\n".join(lines) + "\n")


def _yaml_str(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
