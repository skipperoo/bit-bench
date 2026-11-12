import { getCompressorColor, getCompressorFamily } from '@/lib/compressors'

/**
 * Colour chip identifying a compressor across pages (same colour as its chart
 * series). Custom packages are drawn as a plus, like their chart marker.
 */
export default function CompressorSwatch({ name, color }: { name: string; color?: string }) {
  const fill = color ?? getCompressorColor(name)
  const custom = getCompressorFamily(name) === 'Custom'
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" className="shrink-0" aria-hidden="true">
      {custom
        ? <polygon points="3.5,0 6.5,0 6.5,3.5 10,3.5 10,6.5 6.5,6.5 6.5,10 3.5,10 3.5,6.5 0,6.5 0,3.5 3.5,3.5" fill={fill} />
        : <rect width={10} height={10} rx={2} fill={fill} />}
    </svg>
  )
}
