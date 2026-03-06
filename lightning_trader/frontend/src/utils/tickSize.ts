// 台灣與海外期權正確 Tick 級距表
export const getTickSize = (price: number, symbol: string): number => {
  const sym = symbol.toUpperCase();
  if (sym.startsWith('TXF') || sym.startsWith('MXF') || sym.startsWith('TX') || sym.startsWith('MX')) return 1;
  if (sym.startsWith('UD') || sym.startsWith('MYM')) return 1;
  if (sym.startsWith('NQ') || sym.startsWith('MNQ')) return 0.25;
  if (sym.startsWith('ES') || sym.startsWith('MES')) return 0.25;

  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.10;
  if (price < 500) return 0.50;
  if (price < 1000) return 1.00;
  if (price >= 10000) return 1.00; 
  return 5.00;
};
