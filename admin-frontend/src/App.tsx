import { BrowserRouter, Routes, Route } from 'react-router-dom'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<div>Admin Login</div>} />
        <Route path="/" element={<div>Admin Dashboard</div>} />
      </Routes>
    </BrowserRouter>
  )
}
