import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SettingsProvider } from './contexts/SettingsContext';
import { ToastProvider } from './contexts/ToastContext';
import LoginPanel from './components/LoginPanel';
import Dashboard from './components/Dashboard';
import './index.css';

function App() {
  return (
    <ToastProvider>
      <SettingsProvider>
        <Router>
          <Routes>
            <Route path="/login" element={<LoginPanel />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </Router>
      </SettingsProvider>
    </ToastProvider>
  );
}

export default App;
