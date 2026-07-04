import * as React from 'react'
import { cn } from '@/lib/utils'

interface SliderProps {
  min: number
  max: number
  step?: number
  value: number
  onChange: (value: number) => void
  className?: string
}

function Slider({ min, max, step = 1, value, onChange, className }: SliderProps) {
  const percentage = ((value - min) / (max - min)) * 100

  return (
    <div className={cn('relative flex items-center h-5 w-32', className)}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
      />
      <div className="absolute inset-0 h-1.5 top-1/2 -translate-y-1/2 rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <div
        className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-primary border-2 border-background shadow"
        style={{ left: `calc(${percentage}% - 8px)` }}
      />
    </div>
  )
}

export { Slider }
