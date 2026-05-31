import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SettingsProvider } from './contexts/SettingsContext';
import { ToastProvider } from './contexts/ToastContext';
import { SoundProvider } from './contexts/SoundContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import LoginPanel from './components/LoginPanel';
import Dashboard from './components/Dashboard';
import './index.css';

function App() {
  return (
    <ErrorBoundary label="App">
      <ToastProvider>
        <SettingsProvider>
          <SoundProvider>
            <Router>
              <Routes>
                <Route path="/login" element={
                  <ErrorBoundary label="LoginPanel"><LoginPanel /></ErrorBoundary>
                } />
                <Route path="/dashboard" element={
                  <ErrorBoundary label="Dashboard"><Dashboard /></ErrorBoundary>
                } />
                <Route path="*" element={<Navigate to="/login" replace />} />
              </Routes>
            </Router>
          </SoundProvider>
        </SettingsProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}

export default App;
