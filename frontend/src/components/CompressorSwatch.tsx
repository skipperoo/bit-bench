import { getCompressorColor } from '@/lib/compressors'
import { LegendMarker } from '@/components/charts/CompressorMarker'

/**
 * Chip identifying a compressor across pages: same colour and marker shape as
 * its chart series (shapes tell apart compressors that share a colour).
 */
export default function CompressorSwatch({ name, color, shape }: { name: string; color?: string; shape?: string }) {
  return <LegendMarker name={name} color={color ?? getCompressorColor(name)} shape={shape} size={12} />
}
