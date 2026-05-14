/**
 * SmartOrdersPanel — 本地監控的智慧單清單
 *
 * 顯示 SmartOrderEngine 內所有 active 的 MIT / TRAILING / OCO / BRACKET 訂單。
 * 每列：類型 + 商品 + 方向 + 數量 + 觸發條件（價或 trailing offset）+ 建立時間 + X 取消按鈕。
 *
 * 互動：
 *   - X 按鈕：DELETE /api/smart_orders/{id}（toast 回饋）
 *   - 全部取消（依當前 targetSymbol）
 *   - 點商品名 → setTargetSymbol（與 WatchlistPanel 一致行為）
 */
import React, { useEffect, useState } from 'react';
import { X, Zap, TrendingDown, Plus } from 'lucide-react';
import { apiClient, normalizeApiError } from '../api/client';
import { useTradingContext } from '../contexts/TradingContext';
import { useToast } from '../contexts/ToastContext';
import { formatPrice } from '../utils/instrument';

const SmartOrdersPanel: React.FC = () => {
  const { smartOrders, refreshSmartOrders, subscribe, targetSymbol } = useTradingContext();
  const { toast } = useToast();
  // R3：trailing-stop 新增表單
  const [showAdd, setShowAdd] = useState(false);
  const [addAction, setAddAction] = useState<'Buy' | 'Sell'>('Sell');
  const [addQty, setAddQty] = useState(1);
  const [addOffset, setAddOffset] = useState(10);

  // mount 拉一次；之後靠 WS SmartOrderUpdate 增量同步（TradingContext 已接好）
  useEffect(() => { refreshSmartOrders(); }, [refreshSmartOrders]);

  const submitTrailing = async () => {
    if (!targetSymbol) { toast.error('請先選定商品'); return; }
    if (addQty <= 0 || addOffset <= 0) { toast.error('口數與 offset 都要 > 0'); return; }
    try {
      await apiClient.post('/smart_orders', {
        symbol: targetSymbol,
        action: addAction,
        qty: addQty,
        order_type: 'TRAILING',
        trailing_offset: addOffset,
      });
      toast.success(`已掛移動停損：${addAction === 'Sell' ? '多頭平倉' : '空頭平倉'} ${addQty} 口 / ±${addOffset}`);
      setShowAdd(false);
      setTimeout(() => refreshSmartOrders(), 200);
    } catch (e) {
      const err = normalizeApiError(e);
      toast.error(err.user_msg || '新增移動停損失敗');
    }
  };

  const cancelOne = async (id: string) => {
    try {
      await apiClient.delete(`/smart_orders/${encodeURIComponent(id)}`);
      toast.success(`智慧單 ${id} 已取消`);
      setTimeout(() => refreshSmartOrders(), 200);
    } catch (e) {
      const err = normalizeApiError(e);
      toast.error(err.user_msg || '取消失敗');
    }
  };

  const cancelAll = async () => {
    if (!smartOrders || smartOrders.length === 0) return;
    toast.warn(`將取消 ${smartOrders.length} 張智慧單`, {
      actionLabel: '確認取消全部',
      durationMs: 8000,
      onAction: async () => {
        try {
          await apiClient.post('/smart_orders/cancel_all');
          toast.success('已取消全部智慧單');
          setTimeout(() => refreshSmartOrders(), 200);
        } catch (e) {
          const err = normalizeApiError(e);
          toast.error(err.user_msg || '取消全部失敗');
        }
      },
    });
  };

  const active = (smartOrders || []).filter((o) => o.is_active);

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <div className="px-3 py-2 border-b border-slate-700/50 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-purple-400" />
          智慧單 ({active.length})
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowAdd((v) => !v)}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border transition-colors cursor-pointer ${showAdd ? 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]' : 'bg-amber-700/30 hover:bg-amber-700/50 text-amber-200 border-amber-700/50'}`}
            title="新增移動停損（trailing stop）"
          >
            <Plus className="w-3 h-3" /> 移停
          </button>
          {active.length > 0 && (
            <button
              onClick={cancelAll}
              className="flex items-center gap-1 px-2 py-0.5 bg-red-700/40 hover:bg-red-700/60 text-red-200 rounded text-[10px] font-bold border border-red-700/50 transition-colors cursor-pointer"
            >
              <X className="w-3 h-3" /> 全部取消
            </button>
          )}
        </div>
      </div>
      {showAdd && (
        <div className="px-3 py-2 border-b border-slate-700/50 bg-amber-950/20 text-[11px] flex flex-wrap items-center gap-2">
          <span className="text-slate-400 font-bold">移動停損 ({targetSymbol || '請選商品'})</span>
          <select
            value={addAction}
            onChange={(e) => setAddAction(e.target.value as 'Buy' | 'Sell')}
            className="bg-[#101623] border border-slate-700 rounded text-slate-200 px-1.5 py-0.5"
            title="多頭平倉=賣出，空頭平倉=買進"
          >
            <option value="Sell">賣 (多頭出場)</option>
            <option value="Buy">買 (空頭出場)</option>
          </select>
          <label className="flex items-center gap-1">
            <span className="text-slate-500 text-[10px]">口數</span>
            <input
              type="number" min={1} max={1000} value={addQty}
              onChange={(e) => setAddQty(Math.max(1, parseInt(e.target.value || '1', 10)))}
              className="w-12 bg-[#101623] border border-slate-700 rounded text-right text-slate-200 px-1 py-0.5"
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-slate-500 text-[10px]">offset</span>
            <input
              type="number" min={0.01} step={0.01} value={addOffset}
              onChange={(e) => setAddOffset(Math.max(0.01, parseFloat(e.target.value || '0') || 0))}
              className="w-16 bg-[#101623] border border-slate-700 rounded text-right text-slate-200 px-1 py-0.5"
            />
          </label>
          <button
            onClick={submitTrailing}
            className="px-3 py-0.5 bg-amber-600 hover:bg-amber-500 text-white rounded text-[11px] font-bold transition-colors cursor-pointer"
          >
            送出
          </button>
        </div>
      )}
      <div className="flex-1 overflow-auto custom-scrollbar">
        {active.length === 0 ? (
          <div className="py-10 text-center text-slate-600 italic text-xs">
            無啟用中的智慧單<br />
            <span className="text-[10px] text-slate-700">DOM 上 Shift + 點價格可加觸價單</span>
          </div>
        ) : (
          <table className="w-full text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-[#1C2331] text-slate-500">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">類型</th>
                <th className="px-2 py-1.5 text-left font-medium">商品</th>
                <th className="px-2 py-1.5 text-left font-medium">方向</th>
                <th className="px-2 py-1.5 text-right font-medium">口數</th>
                <th className="px-2 py-1.5 text-right font-medium">觸發 / 跟隨</th>
                <th className="px-2 py-1.5 w-6"></th>
              </tr>
            </thead>
            <tbody>
              {active.map((o) => {
                const isTrailing = o.order_type === 'TRAILING' || o.trailing_offset > 0;
                const isCurrent = o.symbol === targetSymbol;
                return (
                  <tr key={o.id} className="hover:bg-slate-700/40 border-b border-slate-800/60">
                    <td className="px-2 py-1 font-mono font-bold">
                      {isTrailing ? (
                        <span className="text-amber-400 flex items-center gap-1">
                          <TrendingDown className="w-3 h-3" /> 移停
                        </span>
                      ) : (
                        <span className="text-purple-400 flex items-center gap-1">
                          <Zap className="w-3 h-3" /> {o.order_type === 'MIT' ? 'MIT' : '停損'}
                        </span>
                      )}
                    </td>
                    <td
                      className={`px-2 py-1 font-mono font-bold cursor-pointer hover:text-[#D4AF37] ${isCurrent ? 'text-[#D4AF37]' : 'text-slate-200'}`}
                      onClick={() => subscribe(o.symbol)}
                      title="點擊切換到此商品"
                    >
                      {o.symbol}
                    </td>
                    <td className={`px-2 py-1 font-bold ${o.action === 'Buy' ? 'text-red-400' : 'text-emerald-400'}`}>
                      {o.action === 'Buy' ? '買' : '賣'}
                    </td>
                    <td className="px-2 py-1 text-right text-slate-200">{o.qty}</td>
                    <td className="px-2 py-1 text-right font-mono">
                      {isTrailing ? (
                        <span className="text-amber-300">±{o.trailing_offset}</span>
                      ) : (
                        <span className="text-slate-200">
                          {o.trigger_condition?.includes('gte') ? '≥' : '≤'} {formatPrice(o.trigger_price, o.symbol)}
                        </span>
                      )}
                    </td>
                    <td className="px-1 py-1 text-right">
                      <button
                        onClick={() => cancelOne(o.id)}
                        className="hover:bg-red-500/20 hover:text-red-400 text-slate-500 rounded p-0.5 transition-all"
                        title="取消"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default SmartOrdersPanel;
