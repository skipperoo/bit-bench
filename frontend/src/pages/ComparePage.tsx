import { useState } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'

export default function ComparePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Compare Benchmarks</h1>
      <p className="text-muted-foreground">Select up to 5 benchmarks to compare.</p>
      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Benchmark comparison will be available once benchmarks are completed.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
