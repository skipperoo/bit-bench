import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth-store'
import { useChartStyles } from '@/stores/chart-styles-store'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/layout/ThemeToggle'
import { apiFetch } from '@/lib/api'
import {
  BarChart3,
  Boxes,
  Upload,
  Activity,
  LogOut,
  Database,
} from 'lucide-react'
import { PhoneNav } from '@/components/layout/PhoneNav'
import { OfflineNotice } from '@/components/layout/OfflineNotice'

const navItems = [
  { path: '/new', label: 'New', icon: Upload },
  { path: '/experiments', label: 'Experiments', icon: BarChart3 },
  { path: '/datasets', label: 'Datasets', icon: Database },
  { path: '/compressors', label: 'Compressors', icon: Boxes },
  { path: '/status', label: 'Status', icon: Activity },
]

export function AppLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const logout = useAuthStore((s) => s.logout)
  // Result pages are dense (sidebar + charts + wide tables): give them the
  // screen width; task pages keep the narrower reading width.
  const container = location.pathname.startsWith('/experiments')
    ? 'max-w-[120rem] px-4 lg:px-6'
    : 'max-w-7xl px-4'

  const handleLogout = async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' })
    } catch {
      // proceed with local logout even if API call fails
    }
    logout()
    useChartStyles.getState().clear()
    navigate('/login')
  }

  return (
    <div className="min-h-screen flex flex-col max-md:pt-[env(safe-area-inset-top)]">
      {/* Phones: an opaque band behind the status bar so content never scrolls under it. */}
      <div className="md:hidden fixed inset-x-0 top-0 z-40 h-[env(safe-area-inset-top)] bg-background" aria-hidden="true" />
      {/* Phones navigate with the bottom tab bar (PhoneNav). */}
      <header className="max-md:hidden border-b sticky top-0 bg-background z-20">
        <div className={`${container} mx-auto h-14 flex items-center justify-between`}>
          <Link to="/experiments" className="font-bold text-lg">
            BitBench
          </Link>
          <nav className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              const Icon = item.icon
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  viewTransition
                  className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
                    location.pathname.startsWith(item.path)
                      ? 'bg-secondary text-secondary-foreground'
                      : 'hover:bg-secondary/50'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {item.label}
                </Link>
              )
            })}
            <ThemeToggle className="ml-2" />
            <Button variant="ghost" size="sm" onClick={handleLogout} className="ml-1">
              <LogOut className="w-4 h-4 mr-2" />
              Logout
            </Button>
          </nav>
        </div>
      </header>
      <main className={`${container} flex-1 mx-auto w-full py-6 max-md:pt-4 max-md:pb-[calc(5.5rem+env(safe-area-inset-bottom))]`}>
        <OfflineNotice />
        <Outlet />
      </main>
      <PhoneNav onLogout={handleLogout} />
    </div>
  )
}
