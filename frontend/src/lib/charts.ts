/** Above this many bars, bar charts switch to horizontal so labels stay readable. */
export const HORIZONTAL_THRESHOLD = 12

/** Palette for benchmark series in comparisons (distinct from compressor colours). */
export const BENCHMARK_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b', '#0891b2']

/** Ranks of values (1 = best), ties share a rank. */
export function rankValues(values: (number | null)[], lowerIsBetter: boolean): (number | null)[] {
  const present = values.filter((v): v is number => v != null)
  const sorted = [...new Set(present)].sort((a, b) => (lowerIsBetter ? a - b : b - a))
  return values.map((v) => (v == null ? null : sorted.indexOf(v) + 1))
}
