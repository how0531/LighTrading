/**
 * instrument utils 測試
 */
import { describe, it, expect } from 'vitest';
import { getTickSize, formatPrice, isStockSymbol } from './instrument';

describe('getTickSize', () => {
  it('TXF / MXF futures → 1', () => {
    expect(getTickSize(17000, 'TXFR1')).toBe(1);
    expect(getTickSize(17000, 'MXFR1')).toBe(1);
  });

  it('NQ / MNQ → 0.25', () => {
    expect(getTickSize(15000, 'NQ')).toBe(0.25);
    expect(getTickSize(15000, 'MNQ')).toBe(0.25);
  });

  it('TWSE tick ladder by price', () => {
    expect(getTickSize(5, '2330')).toBe(0.01);
    expect(getTickSize(30, '2330')).toBe(0.05);
    expect(getTickSize(80, '2330')).toBe(0.10);
    expect(getTickSize(300, '2330')).toBe(0.50);
    expect(getTickSize(800, '2330')).toBe(1.00);
    expect(getTickSize(2000, '2330')).toBe(5.00);
    expect(getTickSize(20000, '2330')).toBe(1.00);
  });

  it('is case-insensitive', () => {
    expect(getTickSize(17000, 'txfr1')).toBe(1);
  });
});

describe('formatPrice', () => {
  it('futures → no decimals', () => {
    expect(formatPrice(17050.5, 'TXFR1')).toBe('17051');
  });

  it('NQ → 2 decimals', () => {
    expect(formatPrice(15000.25, 'NQ')).toBe('15000.25');
  });

  it('TWSE high-price → no decimals when >= 1000', () => {
    expect(formatPrice(1234.5, '2330')).toBe('1235');
  });

  it('TWSE mid-price → 1 decimal', () => {
    expect(formatPrice(123.45, '2330')).toBe('123.5');
  });

  it('TWSE low-price → 2 decimals', () => {
    expect(formatPrice(12.345, '2330')).toBe('12.35');
  });
});

describe('isStockSymbol', () => {
  it('matches 4-digit numeric only', () => {
    expect(isStockSymbol('2330')).toBe(true);
    expect(isStockSymbol('TXFR1')).toBe(false);
    expect(isStockSymbol('23300')).toBe(false);
    expect(isStockSymbol('233')).toBe(false);
  });
});
