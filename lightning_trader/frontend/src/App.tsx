import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SettingsProvider } from './contexts/SettingsContext';
import { ToastProvider } from './contexts/ToastContext';
import { ConfirmProvider } from './contexts/ConfirmContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import LoginPanel from './components/LoginPanel';
import Dashboard from './components/Dashboard';
import PanelWindow from './components/PanelWindow';
import './index.css';

function App() {
  return (
    <ErrorBoundary label="App">
      <ToastProvider>
        <ConfirmProvider>
          <SettingsProvider>
            <Router>
              <Routes>
                <Route path="/login" element={
                  <ErrorBoundary label="LoginPanel"><LoginPanel /></ErrorBoundary>
                } />
                <Route path="/dashboard" element={
                  <ErrorBoundary label="Dashboard"><Dashboard /></ErrorBoundary>
                } />
                <Route path="/panel/:id" element={
                  <ErrorBoundary label="PanelWindow"><PanelWindow /></ErrorBoundary>
                } />
                <Route path="*" element={<Navigate to="/login" replace />} />
              </Routes>
            </Router>
          </SettingsProvider>
        </ConfirmProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}

export default App;
