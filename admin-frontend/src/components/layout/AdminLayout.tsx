import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth-store'
import { Users, Layers, BarChart3, LogOut, Shield } from 'lucide-react'

const navItems = [
  { path: '/users', label: 'Users', icon: Users },
  { path: '/groups', label: 'Groups', icon: Layers },
  { path: '/benchmarks', label: 'Benchmarks', icon: BarChart3 },
]

export function AdminLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const logout = useAuthStore((s) => s.logout)

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 bg-neutral-900 text-white flex flex-col">
        <div className="p-4 border-b border-neutral-700">
          <Link to="/" className="flex items-center gap-2 font-bold">
            <Shield className="w-5 h-5" />
            BitBench Admin
          </Link>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon
            const active = location.pathname.startsWith(item.path)
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
                  active ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
                }`}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="p-2 border-t border-neutral-700">
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-neutral-400 hover:text-white hover:bg-neutral-800 w-full"
          >
            <LogOut className="w-4 h-4" />
            Logout
          </button>
        </div>
      </aside>
      <main className="flex-1 bg-neutral-50 p-6 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
