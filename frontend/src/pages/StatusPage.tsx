import { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { apiFetch } from '@/lib/api'
import type { QueueStatus } from '@/types'

export default function StatusPage() {
  const [status, setStatus] = useState<QueueStatus | null>(null)

  useEffect(() => {
    apiFetch<QueueStatus>('/status')
      .then(setStatus)
      .catch(() => {})
  }, [])

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">System Status</h1>
      {status && (
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
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Failed</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold text-red-600">{status.stats.failed}</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
