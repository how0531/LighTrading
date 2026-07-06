/**
 * IndicatorPicker — TradingView 式指標選擇器（Sprint E）
 *
 * 左欄：搜尋（中文名/id 模糊）+ 類別分頁（全部/主圖/副圖/自訂/收藏）+ 指標庫列表
 *      （星號收藏、加入；自訂分頁可新增/編輯/刪除自訂 JS 指標）。
 * 右欄：已啟用清單 — 眼睛顯隱、參數編輯（schema 動態表單）、每條線的
 *      顏色/線寬(1-3)/實虛線、上移下移、移除。
 * 持久化：settings.chart（SettingsContext → localStorage + 後端同步）。
 */
import React, { useMemo, useState } from 'react';
import {
  X, Star, Eye, EyeOff, ChevronUp, ChevronDown, Trash2, Plus,
  Settings2, Pencil, LineChart,
} from 'lucide-react';
import { useSettings } from '../contexts/SettingsContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { INDICATOR_REGISTRY, type IndicatorParamDef } from '../utils/indicatorRegistry';
import {
  createActiveIndicator,
  isCustomIndicatorId,
  resolveIndicatorInfo,
  resolveLineStyle,
  type ActiveIndicatorConfig,
  type ChartIndicatorSettings,
  type CustomIndicatorDef,
  type LineStyleOverride,
} from '../utils/chartIndicatorSettings';
import type { Candle } from '../utils/indicators';
import { fuzzyMatch, toHexColor } from '../utils/indicatorPickerUtils';
import CustomIndicatorEditor from './CustomIndicatorEditor';

type TabId = 'all' | 'overlay' | 'pane' | 'custom' | 'favorite';

const TABS: { id: TabId; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'overlay', label: '主圖' },
  { id: 'pane', label: '副圖' },
  { id: 'custom', label: '自訂' },
  { id: 'favorite', label: '收藏' },
];

interface LibraryEntry {
  id: string;
  name: string;
  category: 'overlay' | 'pane' | 'custom';
  custom?: CustomIndicatorDef;
}

interface IndicatorPickerProps {
  isOpen: boolean;
  onClose: () => void;
  /** 驗證自訂指標用的當前 K 棒（無資料時 editor 會用合成資料） */
  getBars: () => Candle[];
}

const IndicatorPicker: React.FC<IndicatorPickerProps> = ({ isOpen, onClose, getBars }) => {
  const { settings, updateSetting } = useSettings();
  const { confirm } = useConfirm();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<TabId>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 編輯器狀態：undefined = 關閉；null = 新增；def = 編輯既有
  const [editorTarget, setEditorTarget] = useState<CustomIndicatorDef | null | undefined>(undefined);

  const chart = settings.chart;

  const updateChart = (mutate: (c: ChartIndicatorSettings) => ChartIndicatorSettings) => {
    updateSetting((prev) => ({ ...prev, chart: mutate(prev.chart) }));
  };

  const library: LibraryEntry[] = useMemo(() => [
    ...INDICATOR_REGISTRY.map((m) => ({ id: m.id, name: m.name, category: m.category })),
    ...chart.custom.map((c) => ({ id: c.id, name: c.name, category: 'custom' as const, custom: c })),
  ], [chart.custom]);

  const filtered = useMemo(() => library.filter((e) => {
    if (tab === 'overlay' && e.category !== 'overlay') return false;
    if (tab === 'pane' && e.category !== 'pane') return false;
    if (tab === 'custom' && e.category !== 'custom') return false;
    if (tab === 'favorite' && !chart.favorites.includes(e.id)) return false;
    return fuzzyMatch(query, `${e.name} ${e.id}`);
  }), [library, tab, query, chart.favorites]);

  if (!isOpen) return null;

  const toggleFavorite = (id: string) => {
    updateChart((c) => ({
      ...c,
      favorites: c.favorites.includes(id)
        ? c.favorites.filter((f) => f !== id)
        : [...c.favorites, id],
    }));
  };

  const addIndicator = (id: string) => {
    updateChart((c) => {
      const cfg = createActiveIndicator(id, c.custom);
      if (!cfg) return c;
      return { ...c, active: [...c.active, cfg] };
    });
  };

  const removeInstance = (instanceId: string) => {
    updateChart((c) => ({ ...c, active: c.active.filter((a) => a.instanceId !== instanceId) }));
    if (expandedId === instanceId) setExpandedId(null);
  };

  const patchInstance = (instanceId: string, patch: Partial<ActiveIndicatorConfig>) => {
    updateChart((c) => ({
      ...c,
      active: c.active.map((a) => (a.instanceId === instanceId ? { ...a, ...patch } : a)),
    }));
  };

  const moveInstance = (instanceId: string, dir: -1 | 1) => {
    updateChart((c) => {
      const idx = c.active.findIndex((a) => a.instanceId === instanceId);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= c.active.length) return c;
      const next = [...c.active];
      [next[idx], next[to]] = [next[to], next[idx]];
      return { ...c, active: next };
    });
  };

  const deleteCustom = async (def: CustomIndicatorDef) => {
    const ok = await confirm({
      title: '刪除自訂指標',
      message: `確認刪除自訂指標「${def.name}」？已啟用的實例會一併移除。`,
      confirmLabel: '刪除',
      danger: true,
    });
    if (!ok) return;
    updateChart((c) => ({
      ...c,
      custom: c.custom.filter((d) => d.id !== def.id),
      active: c.active.filter((a) => a.indicatorId !== def.id),
      favorites: c.favorites.filter((f) => f !== def.id),
    }));
  };

  const saveCustom = (def: CustomIndicatorDef) => {
    updateChart((c) => {
      const exists = c.custom.some((d) => d.id === def.id);
      return {
        ...c,
        custom: exists ? c.custom.map((d) => (d.id === def.id ? def : d)) : [...c.custom, def],
      };
    });
    setEditorTarget(undefined);
  };

  const categoryBadge = (cat: LibraryEntry['category']) =>
    cat === 'overlay' ? '主圖' : cat === 'pane' ? '副圖' : '自訂';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl h-[600px] max-h-[90vh] flex flex-col overflow-hidden bg-[#1C2331] border border-[#29344A] rounded-xl shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="h-12 flex items-center justify-between px-4 border-b border-[#29344A] flex-shrink-0">
          <div className="flex items-center gap-2">
            <LineChart className="w-4 h-4 text-[#D4AF37]" />
            <h2 className="text-sm font-bold text-white tracking-wide">技術指標</h2>
            <span className="text-[10px] text-slate-500">內建 {INDICATOR_REGISTRY.length} 種 + 自訂 {chart.custom.length}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded transition-colors"
            title="關閉"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* ── 左欄：指標庫 ─────────────────────────── */}
          <div className="w-[46%] border-r border-[#29344A] flex flex-col min-h-0">
            <div className="p-2 space-y-2 border-b border-[#29344A]/60">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜尋指標（中文名 / id）…"
                className="w-full bg-[#101623] border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-[#D4AF37]/60 focus:outline-none"
              />
              <div className="flex gap-1">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`px-2 py-0.5 text-[10px] font-bold rounded border transition-colors ${
                      tab === t.id
                        ? 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]'
                        : 'bg-slate-900 text-slate-500 border-slate-700 hover:text-slate-300'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
              {tab === 'custom' && (
                <button
                  onClick={() => setEditorTarget(null)}
                  className="w-full flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] font-bold text-[#D4AF37] border border-dashed border-[#D4AF37]/40 rounded hover:border-[#D4AF37] hover:bg-[#D4AF37]/5 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" /> 新增自訂指標（JS）
                </button>
              )}
              {filtered.length === 0 && (
                <div className="text-center text-[11px] text-slate-600 py-6">
                  {tab === 'favorite' ? '尚無收藏——點列表星號加入' : '找不到符合的指標'}
                </div>
              )}
              {filtered.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-slate-900/40 border border-slate-800 hover:border-slate-600 group"
                >
                  <button
                    onClick={() => toggleFavorite(entry.id)}
                    className={chart.favorites.includes(entry.id)
                      ? 'text-[#D4AF37]'
                      : 'text-slate-700 hover:text-slate-400'}
                    title={chart.favorites.includes(entry.id) ? '取消收藏' : '加入收藏'}
                  >
                    <Star className="w-3.5 h-3.5" fill={chart.favorites.includes(entry.id) ? 'currentColor' : 'none'} />
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-slate-200 truncate">{entry.name}</div>
                    <div className="text-[9px] text-slate-600">
                      {categoryBadge(entry.category)} · {entry.id}
                    </div>
                  </div>
                  {entry.custom && (
                    <>
                      <button
                        onClick={() => setEditorTarget(entry.custom!)}
                        className="p-1 text-slate-500 hover:text-slate-200"
                        title="編輯代碼"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => deleteCustom(entry.custom!)}
                        className="p-1 text-slate-500 hover:text-red-400"
                        title="刪除自訂指標"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => addIndicator(entry.id)}
                    className="px-2 py-0.5 text-[10px] font-bold rounded border bg-slate-900 text-slate-400 border-slate-700 group-hover:text-[#D4AF37] group-hover:border-[#D4AF37]/60 transition-colors"
                  >
                    加入
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* ── 右欄：已啟用清單 ──────────────────────── */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-3 py-2 border-b border-[#29344A]/60 flex items-center gap-2">
              <Settings2 className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-[11px] font-bold text-slate-300">已啟用（{chart.active.length}）</span>
              <span className="text-[9px] text-slate-600">順序 = 副圖 pane 排序</span>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
              {chart.active.length === 0 && (
                <div className="text-center text-[11px] text-slate-600 py-6">
                  尚未啟用任何指標——從左欄「加入」
                </div>
              )}
              {chart.active.map((cfg, idx) => (
                <ActiveIndicatorRow
                  key={cfg.instanceId}
                  cfg={cfg}
                  chart={chart}
                  expanded={expandedId === cfg.instanceId}
                  onToggleExpand={() =>
                    setExpandedId(expandedId === cfg.instanceId ? null : cfg.instanceId)}
                  onPatch={(patch) => patchInstance(cfg.instanceId, patch)}
                  onMoveUp={idx > 0 ? () => moveInstance(cfg.instanceId, -1) : undefined}
                  onMoveDown={idx < chart.active.length - 1 ? () => moveInstance(cfg.instanceId, 1) : undefined}
                  onRemove={() => removeInstance(cfg.instanceId)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {editorTarget !== undefined && (
        <CustomIndicatorEditor
          def={editorTarget}
          getBars={getBars}
          onClose={() => setEditorTarget(undefined)}
          onSave={saveCustom}
        />
      )}
    </div>
  );
};

/* ── 已啟用清單的單列 ──────────────────────────────────── */

interface ActiveRowProps {
  cfg: ActiveIndicatorConfig;
  chart: ChartIndicatorSettings;
  expanded: boolean;
  onToggleExpand: () => void;
  onPatch: (patch: Partial<ActiveIndicatorConfig>) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove: () => void;
}

const ActiveIndicatorRow: React.FC<ActiveRowProps> = ({
  cfg, chart, expanded, onToggleExpand, onPatch, onMoveUp, onMoveDown, onRemove,
}) => {
  const info = resolveIndicatorInfo(cfg.indicatorId, chart.custom);
  if (!info) return null;

  const paramSummary = info.paramDefs.length > 0
    ? `(${info.paramDefs.map((pd) => cfg.params[pd.key] ?? pd.default).join(',')})`
    : '';

  // 樣式編輯的目標線：內建 = registry 線定義；自訂 = 驗證時偵測的 plots
  const lineTargets: Array<{ key: string; label: string; defColor: string; defWidth: 1 | 2 | 3; defStroke: 'solid' | 'dashed' | 'dotted'; isHistogram: boolean }> =
    info.kind === 'builtin' && info.builtinMeta
      ? info.builtinMeta.lines.map((l) => ({
        key: l.key,
        label: l.label,
        defColor: l.color,
        defWidth: l.lineWidth ?? 1,
        defStroke: l.lineStyle ?? 'solid',
        isHistogram: l.style === 'histogram',
      }))
      : (info.customDef?.lines ?? []).map((l) => ({
        key: l.name,
        label: l.name,
        defColor: l.color ?? '#60a5fa',
        defWidth: 1 as const,
        defStroke: 'solid' as const,
        isHistogram: l.style === 'histogram',
      }));

  const setParam = (key: string, raw: string, def: IndicatorParamDef) => {
    const num = Number(raw);
    if (!Number.isFinite(num)) return;
    const clamped = Math.min(def.max, Math.max(def.min, num));
    onPatch({ params: { ...cfg.params, [key]: clamped } });
  };

  const setStyle = (lineKey: string, patch: LineStyleOverride) => {
    onPatch({
      styles: { ...cfg.styles, [lineKey]: { ...cfg.styles[lineKey], ...patch } },
    });
  };

  return (
    <div className="rounded bg-slate-900/40 border border-slate-800">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          onClick={() => onPatch({ visible: !cfg.visible })}
          className={cfg.visible ? 'text-slate-300 hover:text-white' : 'text-slate-700 hover:text-slate-500'}
          title={cfg.visible ? '隱藏' : '顯示'}
        >
          {cfg.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
        </button>
        <button onClick={onToggleExpand} className="flex-1 min-w-0 text-left" title="展開參數/樣式設定">
          <span className={`text-[11px] ${cfg.visible ? 'text-slate-200' : 'text-slate-600'}`}>
            {info.name} <span className="text-slate-500">{paramSummary}</span>
          </span>
          {isCustomIndicatorId(cfg.indicatorId) && (
            <span className="ml-1 text-[8px] px-1 py-px rounded bg-[#D4AF37]/15 text-[#D4AF37] align-middle">JS</span>
          )}
        </button>
        <button
          onClick={onMoveUp}
          disabled={!onMoveUp}
          className="p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-20 disabled:hover:text-slate-500"
          title="上移"
        >
          <ChevronUp className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onMoveDown}
          disabled={!onMoveDown}
          className="p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-20 disabled:hover:text-slate-500"
          title="下移"
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
        <button onClick={onRemove} className="p-0.5 text-slate-500 hover:text-red-400" title="移除">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {expanded && (
        <div className="px-2 pb-2 pt-1 border-t border-slate-800 space-y-2">
          {/* 參數（schema 動態表單） */}
          {info.paramDefs.length > 0 && (
            <div className="space-y-1">
              {info.paramDefs.map((pd) => (
                <label key={pd.key} className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-slate-400">
                    {pd.label}
                    <span className="text-slate-600 ml-1">[{pd.min}–{pd.max}]</span>
                  </span>
                  <input
                    type="number"
                    min={pd.min}
                    max={pd.max}
                    step={pd.step ?? 1}
                    value={cfg.params[pd.key] ?? pd.default}
                    onChange={(e) => setParam(pd.key, e.target.value, pd)}
                    className="w-20 bg-[#101623] border border-slate-700 rounded text-right text-slate-200 text-[10px] px-1 py-0.5 focus:border-[#D4AF37]/60 focus:outline-none"
                  />
                </label>
              ))}
            </div>
          )}
          {/* 線樣式 */}
          {lineTargets.length > 0 ? (
            <div className="space-y-1">
              {lineTargets.map((lt) => {
                const st = resolveLineStyle(
                  { color: lt.defColor, lineWidth: lt.defWidth, lineStyle: lt.defStroke },
                  cfg.styles[lt.key],
                );
                return (
                  <div key={lt.key} className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-400 w-14 truncate" title={lt.label}>{lt.label}</span>
                    <input
                      type="color"
                      value={toHexColor(st.color)}
                      onChange={(e) => setStyle(lt.key, { color: e.target.value })}
                      className="w-6 h-5 bg-transparent border border-slate-700 rounded cursor-pointer p-0"
                      title="顏色"
                    />
                    {!lt.isHistogram && (
                      <>
                        <select
                          value={st.lineWidth}
                          onChange={(e) => setStyle(lt.key, { lineWidth: Number(e.target.value) as 1 | 2 | 3 })}
                          className="bg-[#101623] border border-slate-700 rounded text-slate-300 text-[10px] px-1 py-0.5"
                          title="線寬"
                        >
                          <option value={1}>1px</option>
                          <option value={2}>2px</option>
                          <option value={3}>3px</option>
                        </select>
                        <select
                          value={st.lineStyle}
                          onChange={(e) => setStyle(lt.key, { lineStyle: e.target.value as 'solid' | 'dashed' | 'dotted' })}
                          className="bg-[#101623] border border-slate-700 rounded text-slate-300 text-[10px] px-1 py-0.5"
                          title="線型"
                        >
                          <option value="solid">實線</option>
                          <option value="dashed">虛線</option>
                          <option value="dotted">點線</option>
                        </select>
                      </>
                    )}
                    {lt.isHistogram && <span className="text-[9px] text-slate-600">histogram</span>}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-[9px] text-slate-600">
              （自訂指標：驗證後才有輸出線樣式可調）
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default IndicatorPicker;
