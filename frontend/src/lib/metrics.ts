import type { BenchmarkResult } from '@/types'

/**
 * Compressed bits per element: the container-independent cost of one value.
 * It is computed from the compressed payload size rather than the original
 * 64-bit container, so it can be compared with a different target container
 * (e.g. int16 streams).
 */
export function bitsPerElement(r: BenchmarkResult): number | undefined {
  if (r.compressed_bits == null || r.num_values == null || r.num_values <= 0) return undefined
  return r.compressed_bits / r.num_values
}

/** Width of the uncompressed input container in bits per element (typically 64). */
export function uncompressedBitsPerElement(r: BenchmarkResult): number | undefined {
  if (r.uncompressed_bits == null || r.num_values == null || r.num_values <= 0) return undefined
  return r.uncompressed_bits / r.num_values
}

/**
 * Returns the results with the derived bit-per-element metrics attached.
 * Derived values are client-side only; the API exposes the raw bit counts and
 * the value count.
 */
export function withDerivedMetrics(results: BenchmarkResult[]): BenchmarkResult[] {
  return results.map((r) => ({
    ...r,
    bits_per_element: bitsPerElement(r),
    uncompressed_bits_per_element: uncompressedBitsPerElement(r),
  }))
}
