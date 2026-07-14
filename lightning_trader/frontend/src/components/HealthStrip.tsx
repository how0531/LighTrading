/**
 * HealthStrip — Header 內的緊湊安全健康列
 *
 * 每 6 秒輪詢 GET /api/safety/health，把後端安全網狀態壓成幾個狀態燈：
 *   - 交易態：熔斷/停用（醒目紅）vs 正常（綠）
 *   - 當日下單筆數 / 硬上限（接近上限轉黃→紅）
 *   - 券商連線
 *   - 對帳落差（有資料且超閾值時紅）
 *
 * 這裡是狀態燈，不是漲跌，配色語彙沿用專案的 slate/emerald/amber/red。
 * 端點失敗 / 無資料時優雅降級（顯示「—」，不報錯、不 throw）。
 * 元件卸載時清 interval。
 */
import React, { useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { getSafetyHealth, type SafetyHealth } from '../api/client';

const POLL_MS = 6000;

const HealthStrip: React.FC = () => {
  const [health, setHealth] = useState<SafetyHealth | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const h = await getSafetyHealth();
        if (cancelled) return;
        setHealth(h);
        setFailed(false);
      } catch {
        if (cancelled) return;
        setFailed(true); // 靜默降級，不吵人
      }
    };
    fetchOnce();
    const timer = setInterval(fetchOnce, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const risk = health?.risk ?? null;
  const conn = health?.connection ?? null;
  const recon = health?.last_reconciliation ?? null;

  // 交易態燈：熔斷（紅）/ 正常（綠）/ 未知（灰）
  const halted = risk ? risk.halted : null;

  // 當日下單筆數 / 硬上限；接近上限變色
  const orderCount = risk?.daily_order_count ?? null;
  const maxOrders = risk?.max_orders_per_day ?? null;
  const orderPct =
    maxOrders && maxOrders > 0 && orderCount != null ? orderCount / maxOrders : null;
  const orderColor =
    orderPct == null ? 'text-slate-400'
      : orderPct >= 0.95 ? 'text-red-400'
      : orderPct >= 0.8 ? 'text-amber-300'
      : 'text-slate-300';

  // 券商連線
  const brokerUp = conn ? conn.shioaji_connected : null;

  // 對帳落差：有資料且 delta 非空才顯示；超閾值紅
  const showRecon = recon?.available === true && recon.delta != null;
  const reconBreached = showRecon && recon!.within_threshold === false;

  const dash = '—';

  return (
    <div
      data-testid="health-strip"
      className="hidden xl:flex items-center gap-2.5 mr-3 px-2.5 py-1 rounded-lg bg-slate-900/60 border border-slate-700/60 font-mono tabular-nums"
      title={failed && !health ? '安全健康端點暫時無回應' : '執行期安全網狀態'}
    >
      {/* 交易態 */}
      <div
        data-testid="health-trading"
        className={`flex items-center gap-1 text-[10px] font-black tracking-wide ${
          halted === true ? 'text-red-400'
            : halted === false ? 'text-emerald-400'
            : 'text-slate-500'
        }`}
        title={
          halted === true ? '交易已熔斷/停用'
            : halted === false ? '交易正常'
            : '交易狀態未知'
        }
      >
        {halted === true ? (
          <ShieldAlert className="w-3.5 h-3.5" />
        ) : (
          <ShieldCheck className="w-3.5 h-3.5" />
        )}
        {halted === true ? '熔斷' : halted === false ? '安全' : dash}
      </div>

      <span className="text-slate-700">|</span>

      {/* 當日下單筆數 / 上限 */}
      <div
        data-testid="health-orders"
        className={`text-[10px] font-bold ${orderColor}`}
        title="當日下單筆數 / 每日硬上限"
      >
        <span className="text-slate-500 mr-1 uppercase tracking-wider">單</span>
        {orderCount != null ? orderCount : dash}
        <span className="text-slate-600">/</span>
        {maxOrders != null ? maxOrders : dash}
      </div>

      <span className="text-slate-700">|</span>

      {/* 券商連線 */}
      <div
        data-testid="health-conn"
        className="flex items-center gap-1 text-[10px] font-bold"
        title={brokerUp === true ? '券商已連線' : brokerUp === false ? '券商未連線' : '連線狀態未知'}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            brokerUp === true ? 'bg-emerald-500'
              : brokerUp === false ? 'bg-red-500'
              : 'bg-slate-600'
          }`}
        />
        <span className="text-slate-400 uppercase tracking-wider">券商</span>
      </div>

      {/* 對帳落差（有資料才出現） */}
      {showRecon && (
        <>
          <span className="text-slate-700">|</span>
          <div
            data-testid="health-recon"
            className={`text-[10px] font-bold ${reconBreached ? 'text-red-400' : 'text-slate-400'}`}
            title={`最近對帳落差 ${recon!.delta}（閾值 ${recon!.threshold ?? dash}）${reconBreached ? ' — 已超閾值' : ''}`}
          >
            <span className="text-slate-500 mr-1 uppercase tracking-wider">對帳Δ</span>
            {recon!.delta}
          </div>
        </>
      )}
    </div>
  );
};

export default HealthStrip;
