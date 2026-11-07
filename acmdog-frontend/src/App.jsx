import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import Home from './pages/Home.jsx'
import Problems from './pages/Problems.jsx'
import ProblemDetail from './pages/ProblemDetail.jsx'
import Submissions from './pages/Submissions.jsx'
import Contests from './pages/Contests.jsx'
import ContestDetail from './pages/ContestDetail.jsx'
import Sandbox from './pages/Sandbox.jsx'
import Login from './pages/Login.jsx'
import Register from './pages/Register.jsx'
import Profile from './pages/Profile.jsx'
import Author from './pages/Author.jsx'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/problems" element={<Problems />} />
        <Route path="/problem/:id" element={<ProblemDetail />} />
        <Route path="/problem/:id/submissions" element={<Submissions />} />
        <Route path="/contests" element={<Contests />} />
        <Route path="/contest/:id" element={<ContestDetail />} />
        <Route path="/sandbox" element={<Sandbox />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/author" element={<Author />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
