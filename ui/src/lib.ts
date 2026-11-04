import { invoke, isTauri } from '@tauri-apps/api/core';
export const desktop = isTauri();
export async function api<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktop) throw new Error('当前是浏览器预览。请通过桌面应用访问本地账本。');
  return invoke<T>(command, args);
}
export const money = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
export const percent = (value: number | null | undefined) => value == null ? '—' : `${(value * 100).toFixed(2)}%`;
export function today() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
export const labels: Record<string, string> = { option_open_short: '卖出开仓', option_close: '买入平仓', option_expire: '到期作废', option_assign: '指派 / 行权', shares_buy: '买入股票', shares_sell: '卖出股票', dividend: '分红', fee: '独立费用', adjustment: '现金调整', open: '未平仓', closed: '已平仓', expired: '已作废', assigned: '已指派', active: '进行中' };
export function downloadBytes(name: string, bytes: Uint8Array, mime: string) {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: mime }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function downloadCsv(name: string, rows: (string | number | null)[][]) {
  const text = '﻿' + rows.map(row => row.map(value => {
    let cell = String(value ?? '');
    if (typeof value === 'string' && /^[=+@\-\t\r]/.test(cell)) cell = `'${cell}`;
    return `"${cell.replaceAll('"', '""')}"`;
  }).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
