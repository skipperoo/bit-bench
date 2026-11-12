import { dataSourceText } from '@/lib/experiments'
import type { Benchmark } from '@/types'

/** One-line description of a benchmark's inputs (upload or dataset run). */
export default function DataSourceLine({ benchmark, className }: { benchmark: Benchmark; className?: string }) {
  return <span className={className}>{dataSourceText(benchmark)}</span>
}
