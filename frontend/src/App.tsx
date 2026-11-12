import { BrowserRouter, Routes, Route, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth-store'
import { AppLayout } from '@/components/layout/AppLayout'
import LoginPage from '@/pages/LoginPage'
import UploadPage from '@/pages/UploadPage'
import CompressorsPage from '@/pages/CompressorsPage'
import ExperimentsPage from '@/pages/ExperimentsPage'
import DetailPage from '@/pages/DetailPage'
import ComparePage from '@/pages/ComparePage'
import StatusPage from '@/pages/StatusPage'

/** Temporary bridge until the merged experiment view lands. */
function ExperimentViewRoute() {
  const [params] = useSearchParams()
  const ids = (params.get('ids') ?? '').split(',').filter(Boolean)
  if (ids.length === 1) return <DetailPage idOverride={ids[0]} />
  return <ComparePage />
}

function LegacyDetailRedirect() {
  const { id } = useParams<{ id: string }>()
  return <Navigate to={`/experiments/view?ids=${id}`} replace />
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/new" element={<UploadPage />} />
          <Route path="/experiments" element={<ExperimentsPage />} />
          <Route path="/experiments/view" element={<ExperimentViewRoute />} />
          <Route path="/compressors" element={<CompressorsPage />} />
          <Route path="/status" element={<StatusPage />} />
          {/* Old URLs keep working. */}
          <Route path="/upload" element={<Navigate to="/new" replace />} />
          <Route path="/results" element={<Navigate to="/experiments" replace />} />
          <Route path="/results/:id" element={<LegacyDetailRedirect />} />
          <Route path="/compare" element={<ExperimentViewRoute />} />
        </Route>
        <Route path="*" element={<Navigate to="/experiments" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
