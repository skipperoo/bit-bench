import { AlertTriangle } from 'lucide-react'
import { platformArch } from '@/lib/platforms'
import type { CompressorInstance } from '@/types'

/**
 * Banner for results pages: warns that the listed compressor packages ran
 * through CPU emulation (their target platform differs from the benchmark
 * host), so throughput metrics are distorted.
 */
export default function EmulationNotice({ instances }: { instances: CompressorInstance[] }) {
  const emulated = instances.filter((instance) => instance.emulated)
  if (emulated.length === 0) return null

  return (
    <div className="flex items-start gap-2 mb-6 p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="text-sm">
        <p className="font-medium">CPU emulation — throughput is not representative</p>
        <p className="text-xs mt-1">
          {emulated
            .map((instance) => `${instance.label}${instance.platform ? ` (${platformArch(instance.platform)})` : ''}`)
            .join(', ')}
          {emulated.length === 1 ? ' ran' : ' ran'} under CPU emulation on this host. Compression ratio,
          memory and recall metrics are reliable; compression/decompression throughput and latency numbers are
          distorted and must not be compared directly with native runs.
        </p>
      </div>
    </div>
  )
}
