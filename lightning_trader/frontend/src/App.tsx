import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import LoginPanel from './components/LoginPanel';
import Dashboard from './components/Dashboard';
import './index.css';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<LoginPanel />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
