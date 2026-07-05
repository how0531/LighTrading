/**
 * chartIndicatorSettings.ts — settings.chart 的資料模型（Sprint E）
 *
 * 圖表指標啟用清單 + 參數 + 線樣式 + 收藏 + 自訂指標（含 code），
 * 由 SettingsContext 持久化（localStorage + 後端 /user_settings 同步）。
 * normalizeChartIndicatorSettings 供三處 merge 使用：
 *   localStorage 載入 / 後端 hydration / （picker 一律以完整物件覆寫）。
 */
import {
  getIndicatorMeta,
  sanitizeParams,
  defaultParamsOf,
  type IndicatorParamDef,
  type IndicatorLineDef,
  type IndicatorMeta,
  type LineStrokeStyle,
} from './indicatorRegistry';

/** 單條輸出線的樣式覆寫（未覆寫的欄位落回線定義預設） */
export interface LineStyleOverride {
  color?: string;
  lineWidth?: 1 | 2 | 3;
  lineStyle?: LineStrokeStyle;
}

/** 已啟用的指標實例（同一指標可多實例,如 SMA20 + SMA60） */
export interface ActiveIndicatorConfig {
  instanceId: string;
  /** 內建：registry id；自訂：custom def id（custom_ 開頭） */
  indicatorId: string;
  visible: boolean;
  params: Record<string, number>;
  /** key = 線 key（內建）或 plot 名稱（自訂） */
  styles: Record<string, LineStyleOverride>;
}

/** 自訂指標驗證時偵測到的輸出線（供樣式編輯/掛圖用） */
export interface CustomLineMeta {
  name: string;
  style: 'line' | 'histogram';
  pane: 'main' | 'sub';
  color?: string;
}

export interface CustomIndicatorDef {
  id: string;
  name: string;
  code: string;
  /** 由 //@param 註解解析（儲存時固化） */
  params: IndicatorParamDef[];
  /** 驗證時偵測到的輸出線 */
  lines: CustomLineMeta[];
}

export interface ChartIndicatorSettings {
  active: ActiveIndicatorConfig[];
  /** 收藏的指標 id（內建或自訂皆可） */
  favorites: string[];
  custom: CustomIndicatorDef[];
}

export const CUSTOM_ID_PREFIX = 'custom_';

export function isCustomIndicatorId(id: string): boolean {
  return id.startsWith(CUSTOM_ID_PREFIX);
}

let instSeq = 0;
export function newInstanceId(): string {
  instSeq += 1;
  return `inst_${Date.now().toString(36)}_${instSeq}_${Math.random().toString(36).slice(2, 7)}`;
}

export function newCustomId(): string {
  return `${CUSTOM_ID_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 預設啟用：SMA20 + 成交量（貼近改版前 ChartPanel 的常駐顯示——
 * 舊 MA20 toggle 預設開 + 常駐 volume histogram 遷移為指標系統預設項）。
 */
export function defaultChartIndicatorSettings(): ChartIndicatorSettings {
  return {
    active: [
      { instanceId: 'default_sma20', indicatorId: 'sma', visible: true, params: { period: 20 }, styles: {} },
      { instanceId: 'default_vol', indicatorId: 'vol', visible: true, params: { maPeriod: 5 }, styles: {} },
    ],
    favorites: [],
    custom: [],
  };
}

export interface ResolvedIndicatorInfo {
  kind: 'builtin' | 'custom';
  name: string;
  short: string;
  category: 'overlay' | 'pane';
  paramDefs: IndicatorParamDef[];
  /** 內建才有完整線定義；自訂為驗證時偵測的線（可能為空） */
  builtinMeta?: IndicatorMeta;
  customDef?: CustomIndicatorDef;
}

/** 由 indicatorId 解析顯示/schema 資訊（內建 registry 或自訂 defs） */
export function resolveIndicatorInfo(
  indicatorId: string,
  customDefs: CustomIndicatorDef[],
): ResolvedIndicatorInfo | null {
  const meta = getIndicatorMeta(indicatorId);
  if (meta) {
    return {
      kind: 'builtin',
      name: meta.name,
      short: meta.short,
      category: meta.category,
      paramDefs: meta.params,
      builtinMeta: meta,
    };
  }
  const def = customDefs.find((c) => c.id === indicatorId);
  if (def) {
    return {
      kind: 'custom',
      name: def.name,
      short: def.name,
      // 自訂指標可能同時輸出主圖/副圖線；類別歸「副圖」僅供分頁顯示
      category: 'pane',
      paramDefs: def.params,
      customDef: def,
    };
  }
  return null;
}

/** 新增一個啟用實例（參數帶 schema 預設值） */
export function createActiveIndicator(
  indicatorId: string,
  customDefs: CustomIndicatorDef[],
): ActiveIndicatorConfig | null {
  const info = resolveIndicatorInfo(indicatorId, customDefs);
  if (!info) return null;
  return {
    instanceId: newInstanceId(),
    indicatorId,
    visible: true,
    params: defaultParamsOf(info.paramDefs),
    styles: {},
  };
}

/** 線樣式解析：定義預設 ⊕ 使用者覆寫 */
export function resolveLineStyle(
  def: Pick<IndicatorLineDef, 'color' | 'lineWidth' | 'lineStyle'>,
  ov: LineStyleOverride | undefined,
): { color: string; lineWidth: 1 | 2 | 3; lineStyle: LineStrokeStyle } {
  return {
    color: ov?.color ?? def.color,
    lineWidth: ov?.lineWidth ?? def.lineWidth ?? 1,
    lineStyle: ov?.lineStyle ?? def.lineStyle ?? 'solid',
  };
}

const VALID_WIDTHS = new Set([1, 2, 3]);
const VALID_STROKES = new Set<LineStrokeStyle>(['solid', 'dashed', 'dotted']);

function sanitizeStyleOverride(raw: unknown): LineStyleOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const out: LineStyleOverride = {};
  if (typeof rec.color === 'string' && rec.color) out.color = rec.color;
  if (typeof rec.lineWidth === 'number' && VALID_WIDTHS.has(rec.lineWidth)) {
    out.lineWidth = rec.lineWidth as 1 | 2 | 3;
  }
  if (typeof rec.lineStyle === 'string' && VALID_STROKES.has(rec.lineStyle as LineStrokeStyle)) {
    out.lineStyle = rec.lineStyle as LineStrokeStyle;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sanitizeParamDefs(raw: unknown): IndicatorParamDef[] {
  if (!Array.isArray(raw)) return [];
  const out: IndicatorParamDef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.key !== 'string' || !rec.key) continue;
    if (typeof rec.default !== 'number' || !Number.isFinite(rec.default)) continue;
    const min = typeof rec.min === 'number' && Number.isFinite(rec.min) ? rec.min : -1_000_000;
    const max = typeof rec.max === 'number' && Number.isFinite(rec.max) ? rec.max : 1_000_000;
    out.push({
      key: rec.key,
      label: typeof rec.label === 'string' && rec.label ? rec.label : rec.key,
      default: rec.default,
      min: Math.min(min, max),
      max: Math.max(min, max),
    });
  }
  return out;
}

function sanitizeCustomLines(raw: unknown): CustomLineMeta[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomLineMeta[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== 'string' || !rec.name) continue;
    out.push({
      name: rec.name,
      style: rec.style === 'histogram' ? 'histogram' : 'line',
      pane: rec.pane === 'main' ? 'main' : 'sub',
      ...(typeof rec.color === 'string' && rec.color ? { color: rec.color } : {}),
    });
  }
  return out;
}

/**
 * 持久化資料清洗：
 *   - custom：需有 id/name/code 字串；params/lines 各自 sanitize
 *   - active：indicatorId 必須存在（registry 或 custom）；params clamp 進 schema；
 *     styles 只留合法欄位；instanceId 缺失就補發
 *   - favorites：只留仍存在的 id、去重
 * raw 非物件或 active 非陣列 → 回預設（SMA20 + VOL）。
 */
export function normalizeChartIndicatorSettings(raw: unknown): ChartIndicatorSettings {
  if (!raw || typeof raw !== 'object') return defaultChartIndicatorSettings();
  const rec = raw as Record<string, unknown>;

  const custom: CustomIndicatorDef[] = [];
  if (Array.isArray(rec.custom)) {
    const seenIds = new Set<string>();
    for (const item of rec.custom) {
      if (!item || typeof item !== 'object') continue;
      const c = item as Record<string, unknown>;
      if (typeof c.id !== 'string' || !isCustomIndicatorId(c.id) || seenIds.has(c.id)) continue;
      if (typeof c.name !== 'string' || !c.name.trim()) continue;
      if (typeof c.code !== 'string') continue;
      seenIds.add(c.id);
      custom.push({
        id: c.id,
        name: c.name.trim(),
        code: c.code,
        params: sanitizeParamDefs(c.params),
        lines: sanitizeCustomLines(c.lines),
      });
    }
  }

  if (!Array.isArray(rec.active)) {
    const def = defaultChartIndicatorSettings();
    def.custom = custom;
    // favorites 仍嘗試保留
    if (Array.isArray(rec.favorites)) {
      def.favorites = dedupeKnownIds(rec.favorites, custom);
    }
    return def;
  }

  const active: ActiveIndicatorConfig[] = [];
  const seenInstances = new Set<string>();
  for (const item of rec.active) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (typeof a.indicatorId !== 'string') continue;
    const info = resolveIndicatorInfo(a.indicatorId, custom);
    if (!info) continue; // registry 沒有、自訂也不存在 → 丟棄
    let instanceId = typeof a.instanceId === 'string' && a.instanceId ? a.instanceId : newInstanceId();
    while (seenInstances.has(instanceId)) instanceId = newInstanceId();
    seenInstances.add(instanceId);

    const styles: Record<string, LineStyleOverride> = {};
    if (a.styles && typeof a.styles === 'object') {
      for (const [key, val] of Object.entries(a.styles as Record<string, unknown>)) {
        const st = sanitizeStyleOverride(val);
        if (st) styles[key] = st;
      }
    }
    active.push({
      instanceId,
      indicatorId: a.indicatorId,
      visible: typeof a.visible === 'boolean' ? a.visible : true,
      params: sanitizeParams(info.paramDefs, a.params),
      styles,
    });
  }

  return {
    active,
    favorites: dedupeKnownIds(Array.isArray(rec.favorites) ? rec.favorites : [], custom),
    custom,
  };
}

function dedupeKnownIds(raw: unknown[], custom: CustomIndicatorDef[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    if (!getIndicatorMeta(id) && !custom.some((c) => c.id === id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
