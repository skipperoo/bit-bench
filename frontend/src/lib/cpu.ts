const NOTABLE_FLAGS = [
  'avx512f',
  'avx512bw',
  'avx512vl',
  'avx2',
  'avx',
  'fma',
  'bmi2',
  'bmi1',
  'sse4_2',
  'sse4_1',
  'ssse3',
  'sse2',
  'aes',
  'pclmulqdq',
  'sha_ni',
  'popcnt',
] as const

export function notableFlags(flags: string[]): string[] {
  const present = new Set(flags)
  return NOTABLE_FLAGS.filter((flag) => present.has(flag))
}

export function formatMHz(mhz: number): string {
  if (!mhz || mhz <= 0) return '--'
  if (mhz >= 1000) return `${(mhz / 1000).toFixed(2)} GHz`
  return `${Math.round(mhz)} MHz`
}

export function formatLoad(load: number): string {
  if (!Number.isFinite(load)) return '--'
  return load.toFixed(2)
}

export function formatUtilization(utilization: number): string {
  if (!Number.isFinite(utilization) || utilization < 0) return '0%'
  return `${Math.min(utilization, 100).toFixed(0)}%`
}
