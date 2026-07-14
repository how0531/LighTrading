/**
 * PanicButton — Header 上的恐慌鈕（保命裝置）
 *
 * 一鍵停機：停用交易 + 撤所有委託（含智慧單，雙側）+ 平所有持倉。
 * 因為後果不可逆、且真金交易，點擊必經「雙重確認」：
 *   1. 第一重：明確說明會做什麼（danger 對話框）
 *   2. 第二重：最後防線，再確認一次才真的送出
 * 兩重都用既有 ConfirmContext 的 danger 對話框（紅色確認鈕、Enter/Esc、
 * 開啟時吞掉全域下單快捷鍵），單一誤觸無法引爆。
 *
 * 送出後以既有 toast 回報後端各步結果（撤單筆數 / 平倉檔數 / 錯誤明細）。
 */
import React, { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { panic, normalizeApiError } from '../api/client';
import { useConfirm } from '../contexts/ConfirmContext';
import { useToast } from '../contexts/ToastContext';

const PanicButton: React.FC = () => {
  const { confirm } = useConfirm();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    if (busy) return;

    // ── 第一重確認：說清楚會發生什麼 ──
    const first = await confirm({
      danger: true,
      title: '🛑 恐慌鈕 — 全面停機',
      message:
        '此操作會立即：\n' +
        '・停用交易（拒絕所有新單）\n' +
        '・撤銷所有委託（含智慧單，買賣雙側）\n' +
        '・市價平掉所有持倉\n\n' +
        '確定要繼續？',
      confirmLabel: '繼續',
      cancelLabel: '取消',
    });
    if (!first) return;

    // ── 第二重確認：最後防線，避免誤觸 ──
    const second = await confirm({
      danger: true,
      title: '⚠️ 最後確認',
      message: '再次確認：停用交易 + 撤所有委託 + 平所有倉。\n此動作將立即執行且無法復原。',
      confirmLabel: '執行全平倉/斷路',
      cancelLabel: '返回',
    });
    if (!second) return;

    setBusy(true);
    try {
      const r = await panic();
      const flat = r.flattened_symbols?.length ?? 0;
      const summary = `交易${r.trading_disabled ? '已停用' : '未停用'}・撤單 ${r.cancelled_orders} 筆・平倉 ${flat} 檔`;
      if (r.status === 'ok' && r.errors.length === 0) {
        toast.success(`恐慌鈕已執行：${summary}`);
      } else {
        toast.warn(
          `恐慌鈕部分完成：${summary}\n錯誤 ${r.errors.length} 項：${r.errors.slice(0, 3).join('；')}`,
          { durationMs: 12000 },
        );
      }
    } catch (e) {
      const err = normalizeApiError(e);
      toast.error(`恐慌鈕執行失敗：${err.user_msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      data-testid="panic-button"
      title="恐慌鈕：停用交易 + 撤所有委託（含智慧單，雙側）+ 平所有持倉"
      className="flex items-center gap-1.5 px-3 py-2 rounded-lg font-black text-white bg-red-600 hover:bg-red-500 border border-red-400/70 shadow-[0_0_10px_rgba(239,68,68,0.55)] hover:shadow-[0_0_14px_rgba(239,68,68,0.8)] transition-all cursor-pointer disabled:opacity-60 disabled:cursor-wait"
    >
      <ShieldAlert className="w-4 h-4" />
      <span className="text-[11px] tracking-wider hidden md:inline">
        {busy ? '執行中…' : '🛑 全平倉/斷路'}
      </span>
    </button>
  );
};

export default PanicButton;
