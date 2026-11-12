import { BrowserRouter, Routes, Route, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth-store'
import { AppLayout } from '@/components/layout/AppLayout'
import LoginPage from '@/pages/LoginPage'
import NewExperimentPage from '@/pages/NewExperimentPage'
import CompressorsPage from '@/pages/CompressorsPage'
import ExperimentsPage from '@/pages/ExperimentsPage'
import ExperimentView from '@/pages/ExperimentView'
import StatusPage from '@/pages/StatusPage'

/** Old /compare?ids=... links open the experiment view. */
function LegacyCompareRedirect() {
  const [params] = useSearchParams()
  return <Navigate to={`/experiments/view?ids=${params.get('ids') ?? ''}`} replace />
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
          <Route path="/new" element={<NewExperimentPage />} />
          <Route path="/experiments" element={<ExperimentsPage />} />
          <Route path="/experiments/view" element={<ExperimentView />} />
          <Route path="/compressors" element={<CompressorsPage />} />
          <Route path="/status" element={<StatusPage />} />
          {/* Old URLs keep working. */}
          <Route path="/upload" element={<Navigate to="/new" replace />} />
          <Route path="/results" element={<Navigate to="/experiments" replace />} />
          <Route path="/results/:id" element={<LegacyDetailRedirect />} />
          <Route path="/compare" element={<LegacyCompareRedirect />} />
        </Route>
        <Route path="*" element={<Navigate to="/experiments" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
