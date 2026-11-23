import { useCallback, useEffect, useRef, useState } from 'react';
import { api, desktop, today } from '../lib';
import type { ChainStatus, ChainSync } from '../types';

export interface HeldOptionQuoteRef {
  symbol: string;
  expiry: string;
}

const COOLDOWN_MS = 10 * 60_000;
/** Shared across remounts so switching pages does not refetch the same chains. */
const cooldowns = new Map<string, number>();
let running = false;

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** One fetch per symbol, sized to the furthest-held expiry. */
function targets(entries: HeldOptionQuoteRef[]) {
  const expiryBySymbol = new Map<string, string>();
  for (const entry of entries) {
    const current = expiryBySymbol.get(entry.symbol);
    if (!current || entry.expiry > current) expiryBySymbol.set(entry.symbol, entry.expiry);
  }
  return [...expiryBySymbol.entries()]
    .map(([symbol, expiry]) => ({ symbol, expiry }))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
}

/**
 * Refreshes stored option chains for the contracts currently held.
 *
 * Automatic attempts only touch chains that are missing or older than a day,
 * never overwrite a manual import, and stay quiet on failure. `refresh()`
 * forces every held symbol and reports per-symbol errors.
 */
export function useOptionQuotes(
  entries: HeldOptionQuoteRef[],
  onRefreshed?: () => Promise<unknown> | void,
  enabled = true,
) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [errors, setErrors] = useState<string[]>([]);
  const [checkedAt, setCheckedAt] = useState('');
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const callback = useRef(onRefreshed);
  callback.current = onRefreshed;
  const autoTried = useRef('');
  const key = entries.map(entry => `${entry.symbol}|${entry.expiry}`).sort().join(',');

  const refresh = useCallback(async (force: boolean) => {
    if (!desktop || running) return false;
    const list = targets(entriesRef.current);
    if (!list.length) return false;
    running = true;
    setBusy(true);
    if (force) setErrors([]);
    const failures: string[] = [];
    let updated = false;
    try {
      let statuses: ChainStatus[] = [];
      try {
        statuses = await api<ChainStatus[]>('option_chain_status', {
          symbols: list.map(item => item.symbol),
        });
      } catch (failure) {
        if (force) failures.push(String(failure));
      }
      const bySymbol = new Map(statuses.map(status => [status.symbol, status]));
      const now = Date.now();
      const selected = list.filter(item => {
        if (force) return true;
        const status = bySymbol.get(item.symbol);
        if (!status) return false;
        if (status.status !== 'missing' && status.status !== 'stale') return false;
        if (status.source === 'manual') return false;
        return now - (cooldowns.get(item.symbol) ?? 0) >= COOLDOWN_MS;
      });
      setProgress({ done: 0, total: selected.length });
      const from = today();
      for (const [index, item] of selected.entries()) {
        // Cover the scanner's 90-day window and every held expiry; the
        // provider itself caps the range at 730 days.
        const to = addDays(from, 90) > addDays(item.expiry, 1)
          ? addDays(from, 90)
          : addDays(item.expiry, 1);
        try {
          await api<ChainSync>('fetch_option_chain', { symbol: item.symbol, from, to });
          cooldowns.set(item.symbol, Date.now());
          updated = true;
        } catch (failure) {
          if (force) failures.push(`${item.symbol}：${String(failure)}`);
        }
        setProgress({ done: index + 1, total: selected.length });
      }
      if (updated) {
        setCheckedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
        await callback.current?.();
      }
      if (force) setErrors(failures);
      return updated;
    } finally {
      running = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !desktop || !key) return;
    const attempt = () => {
      if (document.visibilityState === 'hidden' || autoTried.current === key) return;
      autoTried.current = key;
      void refresh(false);
    };
    attempt();
    document.addEventListener('visibilitychange', attempt);
    return () => document.removeEventListener('visibilitychange', attempt);
  }, [enabled, key, refresh]);

  return {
    busy,
    progress,
    errors,
    checkedAt,
    refresh: useCallback(() => refresh(true), [refresh]),
  };
}
