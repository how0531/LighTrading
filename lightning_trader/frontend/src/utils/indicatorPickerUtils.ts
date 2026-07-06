/**
 * indicatorPickerUtils.ts — IndicatorPicker 的純函式（抽出便於測試,
 * 也避免 component 檔案混合匯出非元件觸發 react-refresh 規則）。
 */

/** 模糊比對：子字串命中,或查詢字元依序出現（大小寫不敏感） */
export function fuzzyMatch(query: string, text: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

/** rgba()/#rgb → color input 需要 #rrggbb；解析失敗回灰 */
export function toHexColor(color: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  if (/^#[0-9a-fA-F]{3}$/.test(color)) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
  }
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color);
  if (m) {
    const hex = (n: string) => Number(n).toString(16).padStart(2, '0');
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
  }
  return '#94a3b8';
}
