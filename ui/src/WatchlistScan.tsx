import { useCallback, useEffect, useMemo, useState } from 'react';
import { PlusIcon, RadarIcon, RefreshCwIcon, Trash2Icon, UploadIcon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import type {
  ChainImportPreview, ChainSync, CspCandidate, NewEvent, ScanFlag, WatchlistScanView, WatchlistView,
} from './types';
import { api, desktop, money, percent, today } from './lib';

const chainLabel: Record<string, string> = {
  fresh: '刚刚更新',
  delayed: '延迟',
  stale: '已过期',
  missing: '无期权链',
};

const flagLabels: Partial<Record<ScanFlag, string>> = {
  insufficient_cash: '现金不足',
  chain_stale: '链已过期',
  illiquid: '流动性差',
  deep_itm: '深度实值',
  near_expiry: '临近到期',
};

const flagTone: Partial<Record<ScanFlag, 'destructive' | 'warning'>> = {
  insufficient_cash: 'destructive',
  chain_stale: 'warning',
  illiquid: 'warning',
  deep_itm: 'warning',
  near_expiry: 'warning',
};

function priceSourceLabel(source: CspCandidate['priceSource']) {
  return source === 'bid' ? '买价' : '中间价';
}

export function WatchlistScan({ accountId, onEntry }: {
  accountId: string;
  onEntry: (prefill: Partial<NewEvent>) => void;
}) {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [scan, setScan] = useState<WatchlistScanView | null>(null);
  const [busy, setBusy] = useState(false);
  const [chainBusy, setChainBusy] = useState(false);
  const [chainProgress, setChainProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [importSymbol, setImportSymbol] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ChainImportPreview | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const scanOnce = useCallback(async () => {
    if (!desktop) return null;
    setBusy(true);
    try {
      const result = await api<WatchlistScanView>('scan_watchlist', { accountId });
      setScan(result);
      return result;
    } catch (failure) {
      setError(String(failure));
      return null;
    } finally {
      setBusy(false);
    }
  }, [accountId]);

  const fetchMissingChains = useCallback(async (view: WatchlistScanView) => {
    const targets = view.symbols.filter(row => row.chainStatus === 'missing' || row.chainStatus === 'stale');
    if (!targets.length) { setChainProgress(null); return view; }
    const failures: string[] = [];
    setChainBusy(true);
    for (let index = 0; index < targets.length; index += 1) {
      setChainProgress({ done: index, total: targets.length });
      try {
        await api<ChainSync>('fetch_option_chain', { symbol: targets[index].symbol });
      } catch (failure) {
        failures.push(`${targets[index].symbol}：${String(failure)}`);
      }
    }
    setChainProgress({ done: targets.length, total: targets.length });
    setChainBusy(false);
    if (failures.length) {
      setError(`自动获取期权链失败：${failures.join('；')}。可在下方手动导入。`);
    }
    return scanOnce();
  }, [scanOnce]);

  const refresh = useCallback(async () => {
    if (!desktop) return;
    setError('');
    setStatus('');
    const first = await scanOnce();
    if (first) await fetchMissingChains(first);
  }, [scanOnce, fetchMissingChains]);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await api<WatchlistView>('get_watchlist');
        if (cancelled) return;
        setSymbols(list.symbols);
      } catch (failure) {
        if (!cancelled) setError(String(failure));
        return;
      }
      if (!cancelled) await refresh();
    })();
    return () => { cancelled = true; };
  }, [refresh]);

  async function persist(next: string[]) {
    setBusy(true); setError(''); setStatus('');
    try {
      const saved = await api<WatchlistView>('set_watchlist', { symbols: next });
      setSymbols(saved.symbols);
      setStatus('观察名单已保存。');
      const view = await scanOnce();
      if (view) await fetchMissingChains(view);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  function addSymbol() {
    const value = draft.trim().toUpperCase();
    if (!value) return;
    setDraft('');
    if (symbols.includes(value)) return;
    void persist([...symbols, value]);
  }

  async function fetchOne(symbol: string) {
    setImportBusy(true); setError('');
    try {
      await api<ChainSync>('fetch_option_chain', { symbol });
      await refresh();
    } catch (failure) {
      setError(`${symbol}：${String(failure)}。请手动导入期权链。`);
      setImportSymbol(symbol);
    } finally {
      setImportBusy(false);
    }
  }

  async function previewImport() {
    setImportBusy(true); setError('');
    try {
      setPreview(await api<ChainImportPreview>('option_chain_preview', { text }));
    } catch (failure) {
      setPreview(null);
      setError(String(failure));
    } finally {
      setImportBusy(false);
    }
  }

  async function commitImport() {
    if (!importSymbol) return;
    setImportBusy(true); setError(''); setStatus('');
    try {
      await api<ChainSync>('option_chain_commit', { symbol: importSymbol, text, source: 'manual' });
      setStatus(`${importSymbol} 的期权链已导入。`);
      setImportSymbol(null); setText(''); setPreview(null);
      await scanOnce();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setImportBusy(false);
    }
  }

  function record(candidate: CspCandidate) {
    onEntry({
      kind: 'option_open_short',
      date: today(),
      symbol: candidate.symbol,
      qty: candidate.qty,
      price: candidate.perShare,
      fees: candidate.fees,
      expiry: candidate.expiry,
      strike: candidate.strike,
      right: candidate.right,
      multiplier: candidate.multiplier,
      note: `新开仓扫描 · 年化 ${(candidate.annualized * 100).toFixed(1)}%`,
    });
  }

  const candidates = useMemo(
    () => (scan?.symbols ?? [])
      .flatMap(row => row.outcome?.candidates ?? [])
      .sort((left, right) => right.annualized - left.annualized),
    [scan],
  );
  const missing = (scan?.symbols ?? []).filter(row => row.chainStatus === 'missing' || row.error);
  const cashLabel = !scan
    ? '尚未读取账户现金'
    : !scan.cashTracked
      ? '账户现金未跟踪，按 1 手估算'
      : scan.cash == null
        ? '账户现金不足 1 手保证金'
        : `可用现金 ${money(scan.cash)}`;

  if (!desktop) {
    return <p className="text-sm text-muted-foreground">浏览器预览不读取本地账本，请在桌面应用使用新开仓扫描。</p>;
  }

  return (
    <>
      {error && <Alert variant="error" role="alert"><span>{error}</span></Alert>}
      {status && <Alert variant="success" role="status"><span>{status}</span></Alert>}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><RadarIcon className="size-4 text-muted-foreground" />观察名单</CardTitle>
          <CardDescription>只卖现金担保 Put，按账户可用现金计算可卖手数；最多 30 个标的。</CardDescription>
        </CardHeader>
        <CardPanel className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              添加标的
              <Input
                aria-label="添加观察标的"
                className="w-48 uppercase"
                placeholder="AAPL"
                value={draft}
                disabled={busy}
                onChange={event => setDraft(event.target.value.toUpperCase())}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addSymbol(); } }}
              />
            </label>
            <Button type="button" variant="outline" disabled={busy || !draft.trim()} onClick={addSymbol}><PlusIcon />添加</Button>
            <Button type="button" variant="ghost" disabled={busy || chainBusy} onClick={() => void refresh()}>
              <RefreshCwIcon className={busy || chainBusy ? 'animate-spin' : undefined} />
              {chainBusy && chainProgress ? `获取期权链 ${chainProgress.done}/${chainProgress.total}` : '重新扫描'}
            </Button>
          </div>
          {symbols.length ? (
            <div className="flex flex-wrap gap-1.5">
              {symbols.map(symbol => (
                <span key={symbol} className="inline-flex items-center gap-1 rounded-full border bg-muted/30 py-1 pr-1 pl-3 text-sm">
                  {symbol}
                  <Button variant="ghost" size="icon-xs" aria-label={`移除 ${symbol}`} disabled={busy} onClick={() => void persist(symbols.filter(item => item !== symbol))}>
                    <Trash2Icon />
                  </Button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">先添加愿意接盘的标的，扫描会自动获取期权链。</p>
          )}
        </CardPanel>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">可卖现金担保 Put</CardTitle>
          <CardDescription>{cashLabel} · 14–45 天 · Δ 0.15–0.35 · 买价 · 已过滤低流动性合约</CardDescription>
        </CardHeader>
        <CardPanel className="space-y-3">
          {busy && !scan && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />正在扫描观察名单…</p>}
          {scan && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {scan.symbols.map(row => (
                <span key={row.symbol} className="inline-flex items-center gap-1.5">
                  <strong className="text-foreground">{row.symbol}</strong>
                  {row.price != null ? money(row.price) : '缺少最新价格'}
                  <span>· {chainLabel[row.chainStatus] ?? row.chainStatus}</span>
                  {row.chainStatus !== 'fresh' && (
                    <Button variant="link" size="xs" className="h-auto p-0 text-xs" disabled={importBusy} onClick={() => void fetchOne(row.symbol)}>获取</Button>
                  )}
                  {(row.chainStatus === 'missing' || row.error) && (
                    <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={() => { setImportSymbol(row.symbol); setText(''); setPreview(null); }}>手动导入</Button>
                  )}
                </span>
              ))}
            </div>
          )}

          {importSymbol && (
            <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm">手动导入 {importSymbol} 期权链</strong>
                <Button variant="ghost" size="xs" onClick={() => { setImportSymbol(null); setText(''); setPreview(null); }}>取消</Button>
              </div>
              <Textarea
                aria-label="期权链文本"
                className="min-h-28 font-mono text-xs"
                placeholder="到期日,行权价,方向,买价,卖价,中间价,未平仓量&#10;2026-12-18,150,P,1.20,1.35,1.28,450"
                value={text}
                onChange={event => { setText(event.target.value); setPreview(null); }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" disabled={!text.trim() || importBusy} onClick={() => void previewImport()}>预览</Button>
                <Button size="sm" disabled={!preview || preview.valid === 0 || importBusy} onClick={() => void commitImport()}>
                  <UploadIcon />导入 {preview ? `${preview.valid} 行` : ''}
                </Button>
                {importBusy && <Spinner />}
                {preview && <span className="text-xs text-muted-foreground">有效 {preview.valid} 行，跳过 {preview.invalid} 行</span>}
              </div>
              {preview?.errors.length ? (
                <ul className="list-inside list-disc text-xs text-destructive-foreground">
                  {preview.errors.slice(0, 3).map(item => <li key={`${item.line}-${item.message}`}>第 {item.line} 行：{item.message}</li>)}
                </ul>
              ) : null}
            </div>
          )}

          {!symbols.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><RadarIcon /></EmptyMedia>
                <EmptyTitle>观察名单为空</EmptyTitle>
                <EmptyDescription>添加标的后，应用会获取期权链并按年化收益排序可卖 Put。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : busy && !scan ? null : candidates.length ? (
            <div className="overflow-hidden rounded-xl border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>标的</TableHead>
                    <TableHead>到期 / DTE</TableHead>
                    <TableHead className="text-right">行权价</TableHead>
                    <TableHead className="text-right">权利金 / 股</TableHead>
                    <TableHead className="text-right">Delta</TableHead>
                    <TableHead className="text-right">年化</TableHead>
                    <TableHead className="text-right">可卖</TableHead>
                    <TableHead className="text-right">现金占用</TableHead>
                    <TableHead className="text-right">盈亏平衡</TableHead>
                    <TableHead>标志</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {candidates.slice(0, 60).map(candidate => (
                    <TableRow key={`${candidate.symbol}|${candidate.expiry}|${candidate.strike}`}>
                      <TableCell><strong className="font-medium">{candidate.symbol}</strong></TableCell>
                      <TableCell>
                        <span className="block">{candidate.expiry}</span>
                        <small className="text-xs text-muted-foreground">{candidate.dte} 天</small>
                      </TableCell>
                      <TableCell className="num text-right">{candidate.strike.toFixed(2)}{candidate.right}</TableCell>
                      <TableCell className="num text-right">
                        {money(candidate.perShare)}
                        <small className="block text-xs text-muted-foreground">{priceSourceLabel(candidate.priceSource)}</small>
                      </TableCell>
                      <TableCell className="num text-right">{candidate.delta == null ? '—' : Math.abs(candidate.delta).toFixed(2)}</TableCell>
                      <TableCell className="num text-right">{percent(candidate.annualized)}</TableCell>
                      <TableCell className="num text-right">{candidate.qty}</TableCell>
                      <TableCell className="num text-right">{money(candidate.cashRequired)}</TableCell>
                      <TableCell className="num text-right">{money(candidate.breakeven)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {candidate.flags.map(flag => (
                            <Badge key={flag} variant={flagTone[flag] ?? 'secondary'} size="sm">{flagLabels[flag] ?? flag}</Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Button variant="outline" size="xs" onClick={() => record(candidate)}>记一笔</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {missing.length
                ? `暂无可卖的 Put。${missing.map(row => row.symbol).join('、')} 缺少期权链或最新价格；可获取或手动导入后重试。`
                : '当前筛选条件下没有可卖 Put；可调整价格源、Delta 或到期窗口后重试。'}
            </p>
          )}
        </CardPanel>
      </Card>
    </>
  );
}
