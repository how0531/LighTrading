import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client';
import { KeyRound, ShieldCheck, Cpu, FileKey } from 'lucide-react';

const LoginPanel: React.FC = () => {
  // 預設填入開發用的測試憑證以加速開發與使用者驗證
  const [apiKey, setApiKey] = useState('8HUX8oEN71X7rifZ4NVNymVvY9bTCeGL48isHzLkYbdE');
  const [secretKey, setSecretKey] = useState('8m5Hf8kaRHe7PBtty9cTXz8iH3LiqEFUd2L3wm4rDf6a');
  const [isSim, setIsSim] = useState(false); // 預設使用 Live 環境，因為 CA 憑證是正式版的
  const [caPath, setCaPath] = useState('C:\\ekey\\551\\R124731212\\Sinopac.pfx');
  const [caPasswd, setCaPasswd] = useState('R124731212');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const payload: any = {
        api_key: apiKey.trim(),
        secret_key: secretKey.trim(),
        simulation: isSim
      };

      if (!isSim) {
        payload.ca_path = caPath.trim();
        payload.ca_passwd = caPasswd.trim();
      }

      await apiClient.post('/login', payload);
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.response?.data?.detail || '登入失敗，請檢查連線或金鑰');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-blue-gray-900)] relative overflow-hidden p-4">
      {/* Tech background elements */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-yellow-600/5 rounded-full blur-3xl mix-blend-screen"></div>
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-orange-600/5 rounded-full blur-3xl mix-blend-screen"></div>

      <div className="glass-panel w-full max-w-md p-8 rounded-2xl relative z-10 border border-slate-700/50 shadow-2xl">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 bg-gradient-to-br from-yellow-500 to-orange-400 rounded-xl flex items-center justify-center shadow-lg shadow-yellow-500/20 mb-4">
            <Cpu size={32} className="text-white" />
          </div>
          <h1 className="text-3xl font-bold tracking-wider text-white">LighTrade</h1>
          <p className="text-slate-400 text-sm mt-2 tracking-widest uppercase">NexGen Trading Terminal</p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-3 rounded-lg mb-6 text-sm flex items-center gap-2">
            <ShieldCheck size={16} /> {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-6">
          <div className="space-y-1">
            <label className="text-xs text-slate-400 uppercase tracking-wider font-semibold">API Key</label>
            <div className="relative">
              <KeyRound size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="password"
                required
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full bg-slate-800/80 border border-slate-700 rounded-lg py-3 pl-10 pr-4 text-slate-200 focus:outline-none focus:border-yellow-500 focus:ring-1 focus:ring-yellow-500 transition-all font-mono text-sm"
                placeholder="Enter your Shioaji API Key"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Secret Key</label>
            <div className="relative">
              <KeyRound size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="password"
                required
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                className="w-full bg-slate-800/80 border border-slate-700 rounded-lg py-3 pl-10 pr-4 text-slate-200 focus:outline-none focus:border-yellow-500 focus:ring-1 focus:ring-yellow-500 transition-all font-mono text-sm"
                placeholder="Enter your Shioaji Secret Key"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 py-2">
            <button
              type="button"
              onClick={() => setIsSim(true)}
              className={`flex-1 py-2 rounded-md text-sm font-medium border transition-colors ${isSim ? 'bg-yellow-500/20 border-yellow-500/50 text-yellow-400' : 'bg-slate-800/50 border-slate-700 text-slate-500 hover:text-slate-300'}`}
            >
              Simulation
            </button>
            <button
              type="button"
              onClick={() => setIsSim(false)}
              className={`flex-1 py-2 rounded-md text-sm font-medium border transition-colors ${!isSim ? 'bg-red-500/20 border-red-500/50 text-red-400' : 'bg-slate-800/50 border-slate-700 text-slate-500 hover:text-slate-300'}`}
            >
              Live
            </button>
          </div>

          <div className={`transition-all duration-500 ease-in-out overflow-hidden space-y-6 ${!isSim ? 'max-h-[300px] opacity-100' : 'max-h-0 opacity-0'}`}>
            <div className="space-y-1">
              <label className="text-xs text-slate-400 uppercase tracking-wider font-semibold">CA Path</label>
              <div className="relative">
                <FileKey size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  required={!isSim}
                  value={caPath}
                  onChange={(e) => setCaPath(e.target.value)}
                  className="w-full bg-slate-800/80 border border-slate-700 rounded-lg py-3 pl-10 pr-4 text-slate-200 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 transition-all font-mono text-sm"
                  placeholder="e.g., C:/Sinopac/Sinopac.pfx"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs text-slate-400 uppercase tracking-wider font-semibold">CA Password</label>
              <div className="relative">
                <KeyRound size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  type="password"
                  required={!isSim}
                  value={caPasswd}
                  onChange={(e) => setCaPasswd(e.target.value)}
                  className="w-full bg-slate-800/80 border border-slate-700 rounded-lg py-3 pl-10 pr-4 text-slate-200 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 transition-all font-mono text-sm"
                  placeholder="Enter CA Password"
                />
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className={`w-full font-bold py-3 rounded-lg shadow-lg transition-all flex justify-center items-center gap-2 text-white ${isSim ? 'bg-gradient-to-r from-yellow-600 to-orange-500 hover:from-yellow-500 hover:to-orange-400 shadow-yellow-500/25' : 'bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-500 hover:to-orange-500 shadow-red-500/25'}`}
          >
            {loading ? <span className="animate-pulse">Connecting...</span> : 'INITIALIZE SYSTEM'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default LoginPanel;