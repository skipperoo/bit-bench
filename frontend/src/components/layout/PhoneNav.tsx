import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Activity, BarChart3, Boxes, Database, Download, LogOut, MoreHorizontal, Plus } from 'lucide-react'
import { Sheet } from '@/components/ui/sheet'
import { ThemeToggle } from '@/components/layout/ThemeToggle'
import { canPromptInstall, isIOS, isStandalone, promptInstall } from '@/lib/pwa'
import { cn } from '@/lib/utils'

const TABS = [
  { path: '/experiments', label: 'Experiments', icon: BarChart3 },
  { path: '/datasets', label: 'Datasets', icon: Database },
  { path: '/new', label: 'New', icon: Plus },
  { path: '/compressors', label: 'Compressors', icon: Boxes },
]

/** Phone navigation: a bottom tab bar, with Status, theme, install and log out under More. */
export function PhoneNav({ onLogout }: { onLogout: () => void }) {
  const { pathname } = useLocation()
  const [more, setMore] = useState(false)
  const [iosHelp, setIosHelp] = useState(false)
  const showInstall = !isStandalone() && (canPromptInstall() || isIOS())
  const install = async () => {
    if (canPromptInstall()) {
      await promptInstall()
      setMore(false)
    } else {
      setIosHelp(true)
    }
  }
  // The New experiment wizard has its own bottom bar (Next / Run).
  if (pathname.startsWith('/new')) return null
  const tab = 'flex flex-col items-center gap-0.5 pt-1.5 text-[10px] transition-colors active:opacity-60'
  return (
    <>
      <nav
        aria-label="Main"
        style={{ viewTransitionName: 'phone-nav' }}
        className="md:hidden fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-background/95 backdrop-blur pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        {TABS.map(({ path, label, icon: Icon }) => {
          const on = pathname.startsWith(path)
          return (
            <Link key={path} to={path} viewTransition aria-current={on ? 'page' : undefined}
              className={cn(tab, on ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
              {path === '/new'
                ? <span className="flex h-7 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Icon className="h-4 w-4" /></span>
                : <Icon className="h-5 w-5" />}
              {label}
            </Link>
          )
        })}
        <button type="button" onClick={() => setMore(true)} aria-haspopup="dialog"
          className={cn(tab, pathname.startsWith('/status') ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
          <MoreHorizontal className="h-5 w-5" />More
        </button>
      </nav>

      <Sheet open={more} onClose={() => { setMore(false); setIosHelp(false) }} title="More">
        <div className="space-y-1">
          <Link to="/status" viewTransition onClick={() => setMore(false)} className="flex items-center gap-3 rounded-md px-2 py-3 hover:bg-secondary active:bg-secondary">
            <Activity className="h-5 w-5 text-muted-foreground" />Status
          </Link>
          <div className="flex items-center justify-between gap-3 px-2 py-2">
            <span>Theme</span>
            <ThemeToggle />
          </div>
          {showInstall && (
            <button type="button" onClick={install} className="flex w-full items-center gap-3 rounded-md px-2 py-3 text-left hover:bg-secondary active:bg-secondary">
              <Download className="h-5 w-5 text-muted-foreground" />Install app
            </button>
          )}
          {iosHelp && (
            <p role="note" className="rounded-md bg-secondary px-3 py-2 text-sm">
              In Safari, tap the Share button, then <b>Add to Home Screen</b>.
            </p>
          )}
          <button type="button" onClick={() => { setMore(false); onLogout() }} className="flex w-full items-center gap-3 rounded-md px-2 py-3 text-left hover:bg-secondary active:bg-secondary">
            <LogOut className="h-5 w-5 text-muted-foreground" />Log out
          </button>
        </div>
      </Sheet>
    </>
  )
}
