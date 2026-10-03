import { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { apiFetch } from '@/lib/api'
import { formatLoad, formatMHz, formatUtilization, notableFlags } from '@/lib/cpu'
import type { QueueStatus } from '@/types'

const POLL_INTERVAL_MS = 5000

export default function StatusPage() {
  const [status, setStatus] = useState<QueueStatus | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = () => {
      apiFetch<QueueStatus>('/status')
        .then((data) => {
          if (!cancelled) setStatus(data)
        })
        .catch(() => {})
    }

    load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">System Status</h1>
      {status && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Queue Depth</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{status.queue_depth}</p>
                <p className="text-xs text-muted-foreground mt-1">All users</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Running Workers</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">
                  {status.runner.running}/{status.runner.max_parallelism}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Completed</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-green-600">{status.stats.ready}</p>
                <p className="text-xs text-muted-foreground mt-1">Your benchmarks</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Queued</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-blue-600">{status.stats.queued}</p>
                <p className="text-xs text-muted-foreground mt-1">Your benchmarks</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">In Progress</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-yellow-600">{status.stats.in_progress}</p>
                <p className="text-xs text-muted-foreground mt-1">Your benchmarks</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Failed</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-red-600">{status.stats.failed}</p>
                <p className="text-xs text-muted-foreground mt-1">Your benchmarks</p>
              </CardContent>
            </Card>
          </div>

          {status.cpu && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">CPU</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Card className="sm:col-span-2">
                  <CardHeader>
                    <CardTitle className="text-sm">Model</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xl font-bold break-words">{status.cpu.model || 'Unknown'}</p>
                    <p className="text-xs text-muted-foreground mt-1">{formatMHz(status.cpu.mhz)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Cores</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold">
                      {status.cpu.physical_cores}/{status.cpu.logical_cores}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">physical / logical</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Load (1m)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold">{formatUtilization(status.cpu.utilization)}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {formatLoad(status.cpu.load1)} / {formatLoad(status.cpu.load5)} /{' '}
                      {formatLoad(status.cpu.load15)} (1/5/15m)
                    </p>
                  </CardContent>
                </Card>
              </div>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Instruction Sets</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {notableFlags(status.cpu.flags).map((flag) => (
                      <Badge key={flag} variant="secondary" className="font-mono">
                        {flag}
                      </Badge>
                    ))}
                    {notableFlags(status.cpu.flags).length === 0 && (
                      <p className="text-sm text-muted-foreground">No notable SIMD extensions detected</p>
                    )}
                  </div>
                  {status.cpu.flags.length > 0 && (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer select-none">
                        All {status.cpu.flags.length} flags
                      </summary>
                      <p className="mt-2 font-mono leading-relaxed break-words">
                        {[...status.cpu.flags].sort().join(' ')}
                      </p>
                    </details>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  )
}
