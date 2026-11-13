/** Above this many bars, bar charts switch to horizontal so labels stay readable. */
export const HORIZONTAL_THRESHOLD = 12

/**
 * Categorical palette for benchmark series in comparisons, in fixed order
 * (never cycled). Validated for colour-vision deficiency on the light card
 * (#ffffff) and the dark card (#2b2c31): adjacent CVD ΔE ≥ 8.4, normal-vision
 * ΔE ≥ 19.3. A few slots sit below 3:1 against the surface, which the
 * comparison table under every grouped chart relieves.
 */
export const BENCHMARK_COLORS_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
export const BENCHMARK_COLORS_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
/** Kept for callers that only need the light order. */
export const BENCHMARK_COLORS = BENCHMARK_COLORS_LIGHT
/** Grouped bars show at most this many benchmarks (one per palette slot); the table lists all. */
export const MAX_GROUPED_SERIES = BENCHMARK_COLORS_LIGHT.length

/** Ranks of values (1 = best), ties share a rank. */
export function rankValues(values: (number | null)[], lowerIsBetter: boolean): (number | null)[] {
  const present = values.filter((v): v is number => v != null)
  const sorted = [...new Set(present)].sort((a, b) => (lowerIsBetter ? a - b : b - a))
  return values.map((v) => (v == null ? null : sorted.indexOf(v) + 1))
}
