import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiClient } from "../api/client";
import { KeyRound, ShieldCheck, Cpu, FileKey } from "lucide-react";

const STORAGE_KEY = "lightrade_login";

const LoginPanel: React.FC = () => {
  // 從 localStorage 載入上次的設定（不儲存密碼類欄位）
  const saved = React.useMemo(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }, []);

  const [apiKey, setApiKey] = useState(saved.apiKey || "");
  const [secretKey, setSecretKey] = useState("");
  const [isSim, setIsSim] = useState(saved.isSim ?? true);
  const [caPath, setCaPath] = useState(saved.caPath || "");
  const [caPasswd, setCaPasswd] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const payload: Record<string, unknown> = {
        api_key: apiKey.trim(),
        secret_key: secretKey.trim(),
        simulation: isSim,
      };

      if (!isSim) {
        payload.ca_path = caPath.trim();
        payload.ca_passwd = caPasswd.trim();
      }

      await apiClient.post("/login", payload);
      // 儲存非敏感欄位到 localStorage，下次登入自動帶入
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ apiKey: apiKey.trim(), caPath: caPath.trim(), isSim }));
      navigate("/dashboard");
    } catch (err) {
      const error = err as { response?: { data?: { detail?: string } } };
      setError(error.response?.data?.detail || "登入失敗，請檢查連線或金鑰");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 relative overflow-hidden p-4 font-sans">
      {/* Subtle background glow for depth, replacing the large bright orbs */}
      <div className="absolute top-0 right-0 w-[800px] h-[800px] bg-slate-800/20 rounded-full blur-[120px] mix-blend-screen opacity-50 translate-x-1/3 -translate-y-1/3"></div>

      <div className="w-full max-w-md p-8 rounded-2xl relative z-10 bg-slate-900/80 backdrop-blur-xl border border-slate-700/50 shadow-2xl">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 bg-gradient-to-br from-[#E5A344] to-[#D4AF37] rounded-xl flex items-center justify-center shadow-lg shadow-[#D4AF37]/20 mb-4">
            <Cpu size={32} className="text-white" />
          </div>
          <h1 className="text-3xl font-bold tracking-wider text-white font-mono">
            LighTrade
          </h1>
          <p className="text-slate-400 text-sm mt-2 tracking-widest uppercase font-mono">
            Dawho Professional Edition
          </p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-3 rounded-lg mb-6 text-sm flex items-center gap-2">
            <ShieldCheck size={16} /> {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-6">
          <div className="space-y-1">
            <label className="text-xs text-slate-400 uppercase tracking-wider font-semibold">
              API Key
            </label>
            <div className="relative">
              <KeyRound
                size={18}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
              />
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
            <label className="text-xs text-slate-400 uppercase tracking-wider font-semibold">
              Secret Key
            </label>
            <div className="relative">
              <KeyRound
                size={18}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
              />
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
              className={`flex-1 py-2 rounded-md font-mono text-sm font-semibold border transition-colors ${isSim ? "bg-[#D4AF37]/10 border-[#D4AF37] text-[#D4AF37]" : "bg-slate-800/50 border-slate-700/50 text-slate-500 hover:text-slate-300"}`}
            >
              Simulation
            </button>
            <button
              type="button"
              onClick={() => setIsSim(false)}
              className={`flex-1 py-2 rounded-md font-mono text-sm font-semibold border transition-colors ${!isSim ? "bg-red-500/10 border-red-500 text-red-500" : "bg-slate-800/50 border-slate-700/50 text-slate-500 hover:text-slate-300"}`}
            >
              Live
            </button>
          </div>

          <div
            className={`transition-all duration-500 ease-in-out overflow-hidden space-y-6 ${!isSim ? "max-h-[300px] opacity-100" : "max-h-0 opacity-0"}`}
          >
            <div className="space-y-1">
              <label className="text-xs text-slate-400 uppercase tracking-wider font-semibold font-mono">
                CA Path
              </label>
              <div className="relative">
                <FileKey
                  size={18}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
                />
                <input
                  type="text"
                  required={!isSim}
                  value={caPath}
                  onChange={(e) => setCaPath(e.target.value)}
                  className="w-full bg-slate-950/80 border border-slate-700/80 rounded-lg py-3 pl-10 pr-4 text-slate-200 focus:outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] transition-all font-mono text-sm"
                  placeholder="e.g., C:/Sinopac/Sinopac.pfx"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs text-slate-400 uppercase tracking-wider font-semibold font-mono">
                CA Password
              </label>
              <div className="relative">
                <KeyRound
                  size={18}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
                />
                <input
                  type="password"
                  required={!isSim}
                  value={caPasswd}
                  onChange={(e) => setCaPasswd(e.target.value)}
                  className="w-full bg-slate-950/80 border border-slate-700/80 rounded-lg py-3 pl-10 pr-4 text-slate-200 focus:outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] transition-all font-mono text-sm"
                  placeholder="Enter CA Password"
                />
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className={`w-full font-bold py-3 rounded-lg shadow-lg transition-all flex justify-center items-center gap-2 text-white font-mono ${
              isSim
                ? "bg-gradient-to-r from-[#D4AF37] to-[#C59B2E] hover:from-[#E5A344] hover:to-[#D4AF37] shadow-[#D4AF37]/20 border border-[#D4AF37]/50"
                : "bg-gradient-to-r from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 shadow-red-600/20 border border-red-500/50"
            }`}
          >
            {loading ? (
              <span className="animate-pulse">Connecting...</span>
            ) : (
              "INITIALIZE SYSTEM"
            )}
          </button>
        </form>
      </div>
    </div>
  );
};

export default LoginPanel;
