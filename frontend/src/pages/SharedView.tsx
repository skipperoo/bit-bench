import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ThemeToggle } from '@/components/layout/ThemeToggle'
import ExperimentView from '@/pages/ExperimentView'
import { useAuthStore } from '@/stores/auth-store'

/** Keeps the link out of referrers and search engines while the page is open. */
function usePrivateMeta() {
  useEffect(() => {
    const tags = [['referrer', 'no-referrer'], ['robots', 'noindex, nofollow']].map(([name, content]) => {
      const meta = document.createElement('meta')
      meta.name = name
      meta.content = content
      document.head.appendChild(meta)
      return meta
    })
    return () => tags.forEach((t) => t.remove())
  }, [])
}

/** /s/:token — the read-only results page of a shared link, with a slim bar for everyone. */
export default function SharedView() {
  const { token = '' } = useParams<{ token: string }>()
  const loggedIn = useAuthStore((s) => s.isAuthenticated)()
  usePrivateMeta()
  const container = 'max-w-[120rem] px-4 lg:px-6 mx-auto w-full'
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b sticky top-0 bg-background z-20">
        <div className={`${container} h-14 flex items-center justify-between gap-3`}>
          <span className="font-bold text-lg">BitBench</span>
          <div className="flex items-center gap-2 text-sm">
            <ThemeToggle />
            {loggedIn
              ? <Link to="/experiments" className="rounded-md px-3 py-2 hover:bg-secondary">Open BitBench</Link>
              : <Link to={`/login?next=${encodeURIComponent(`/s/${token}`)}`} className="rounded-md px-3 py-2 hover:bg-secondary">Log in</Link>}
          </div>
        </div>
      </header>
      <main className={`${container} flex-1 py-6`}>
        <ExperimentView key={token} shareToken={token} />
      </main>
    </div>
  )
}
