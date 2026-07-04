import type { CompressorOption } from '@/types'

export function stepsForOption(opt: CompressorOption): number {
  if (opt.type !== 'number' || opt.min == null || opt.max == null) return 0
  const step = opt.step ?? 1
  return (opt.max - opt.min) / step
}

export function shouldUseSlider(opt: CompressorOption): boolean {
  if (opt.type !== 'number') return false
  return stepsForOption(opt) <= 20
}
