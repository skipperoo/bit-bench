import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth-store'
import { AdminLayout } from '@/components/layout/AdminLayout'
import LoginPage from '@/pages/LoginPage'
import UsersPage from '@/pages/UsersPage'
import GroupsPage from '@/pages/GroupsPage'
import BenchmarksPage from '@/pages/BenchmarksPage'

function ProtectedRoute({ children, roles }: { children: React.ReactNode; roles: string[] }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const getRole = useAuthStore((s) => s.getRole)

  if (!isAuthenticated()) return <Navigate to="/login" replace />
  const role = getRole()
  if (!role || !roles.includes(role)) return <Navigate to="/users" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <ProtectedRoute roles={['admin', 'professor']}>
              <AdminLayout />
            </ProtectedRoute>
          }
        >
          <Route
            path="/users"
            element={
              <ProtectedRoute roles={['admin', 'professor']}>
                <UsersPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/groups"
            element={
              <ProtectedRoute roles={['admin']}>
                <GroupsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/benchmarks"
            element={
              <ProtectedRoute roles={['admin']}>
                <BenchmarksPage />
              </ProtectedRoute>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/users" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
