import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { RefreshCwIcon, SearchIcon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, desktop, money, percent, today } from './lib';
import type { MarketQuote, Price, QuoteRefresh } from './types';
import { SymbolPicker } from './SymbolPicker';

const validSymbol = /^[A-Z][A-Z0-9.-]{0,19}$/;
export function latestPrice(prices: Price[], symbol: string) {
  return prices.filter(quote => quote.symbol === symbol).sort((a, b) => b.date.localeCompare(a.date))[0];
}
export function quoteTime(quote?: Price) {
  if (!quote) return '尚无报价';
  const stamp = (quote.quotedAt || quote.date).slice(0, 16).replace('T', ' ');
  return `${stamp} 美东 · ${quote.source || '手动'}`;
}

function useQuote(symbol: string) {
  const [quote, setQuote] = useState<MarketQuote | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setQuote(null); setError(''); setBusy(false);
    if (!desktop || !validSymbol.test(symbol)) return;
    setBusy(true);
    const timer = setTimeout(() => {
      api<MarketQuote>('fetch_quote', { symbol }).then(result => { if (!cancelled) setQuote(result); })
        .catch(failure => { if (!cancelled) setError(String(failure)); })
        .finally(() => { if (!cancelled) setBusy(false); });
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [symbol, retry]);
  return { quote: quote?.symbol === symbol ? quote : null, error, busy, retry: () => setRetry(value => value + 1) };
}

export function QuoteReference({ symbol }: { symbol: string }) {
  const { quote, error, busy, retry } = useQuote(symbol);
  if (!validSymbol.test(symbol)) return null;
  return (
    <div className="quote-reference flex flex-wrap items-baseline gap-x-3 gap-y-1 self-end pb-1 text-xs text-muted-foreground" aria-live="polite">
      {busy ? (
        <span className="flex items-center gap-2"><Spinner className="size-3" />正在读取 {symbol} 标的参考价…</span>
      ) : quote ? (
        <>
          <span>标的参考价 <strong className="num text-sm text-foreground">{money(quote.price)}</strong></span>
          <small>{quote.quotedAt} 美东 · {quote.source} · 可能延迟</small>
          <small className="basis-full">参考价不填入成交价或期权权利金。</small>
        </>
      ) : error ? (
        <>
          <span className="text-destructive">标的参考价不可用：{error}</span>
          <Button type="button" variant="link" size="xs" onClick={retry}>重试报价</Button>
        </>
      ) : (
        <span>在桌面应用中查看标的参考价。</span>
      )}
    </div>
  );
}

export function usePortfolioQuotes(symbols: string[], onUpdated: () => Promise<boolean>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState('');
  const running = useRef(false);
  const pending = useRef<string[]>([]);
  const callback = useRef(onUpdated); callback.current = onUpdated;
  const key = [...new Set(symbols)].sort().join(',');
  const refresh = useCallback(async (requested?: string[]) => {
    const targets = requested ?? (key ? key.split(',') : []);
    if (!desktop || !targets.length) return;
    pending.current = [...new Set([...pending.current, ...targets])];
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    const failures: string[] = [];
    try {
      // Preserve newly added holdings while an earlier request is still running.
      while (pending.current.length) {
        const batch = pending.current.splice(0, 50);
        try {
          const result = await api<QuoteRefresh>('refresh_quotes', { symbols: batch });
          failures.push(...result.failed.map(item => `${item.symbol}：${item.error}`));
          if (result.updated.length && !await callback.current()) failures.push('报价已保存，账本刷新失败，请重试读取账本。');
        } catch (failure) { failures.push(String(failure)); }
      }
      setCheckedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
      setError(failures.join('；'));
    } finally { running.current = false; setBusy(false); }
  }, [key]);
  useEffect(() => {
    if (!key || !desktop) return;
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 300000);
    return () => clearInterval(timer);
  }, [key, refresh]);
  return { busy, error, checkedAt, refresh };
}
export type MarketState = ReturnType<typeof usePortfolioQuotes>;

export function MarketPage({ prices, symbols, market, onSaved, onEntry }: {
  prices: Price[]; symbols: string[]; market: MarketState;
  onSaved: (message: string) => void; onEntry: (symbol: string) => void;
}) {
  const [symbol, setSymbol] = useState('');
  const { quote, error, busy, retry } = useQuote(symbol);
  const rows = [...new Set([...symbols, ...prices.map(item => item.symbol)])].sort();
  return (
    <div className="grid gap-5">
      <Card className="market-search">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><SearchIcon className="size-4 text-muted-foreground" />查找标的</CardTitle>
          <CardDescription>搜索美股或 ETF，查看价格后直接记账。</CardDescription>
        </CardHeader>
        <CardPanel className="space-y-3">
          <SymbolPicker value={symbol} onChange={setSymbol} label="搜索美股或 ETF" />
          {busy && <p className="market-search-status flex items-center gap-2 text-xs text-muted-foreground" role="status"><Spinner className="size-3" />正在读取标的报价…</p>}
          {error && (
            <p className="market-search-status flex flex-wrap items-center gap-2 text-xs text-destructive" role="alert">
              {error}
              <Button type="button" variant="link" size="xs" onClick={retry}>重试查询</Button>
            </p>
          )}
          {quote && (
            <div className="market-result flex flex-wrap items-end justify-between gap-4 rounded-xl border bg-muted/40 p-4">
              <div className="grid gap-1">
                <h3 className="font-heading flex items-baseline gap-2 text-base font-semibold">
                  {quote.symbol}
                  <span className="text-xs font-normal text-muted-foreground">{quote.name}</span>
                </h3>
                <p className="flex items-baseline gap-2">
                  <strong className="num text-2xl font-semibold tracking-tight">{money(quote.price)}</strong>
                  {quote.changePercent != null && (
                    <span className={`num text-sm ${quote.changePercent >= 0 ? 'positive text-success-foreground' : 'negative text-destructive-foreground'}`}>
                      {quote.changePercent > 0 ? '+' : ''}{percent(quote.changePercent / 100)}
                    </span>
                  )}
                </p>
                <small className="text-xs text-muted-foreground">{quote.quotedAt.slice(5, 16)} 美东 · {quote.source} · USD · 可能延迟</small>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={market.busy || !desktop} onClick={() => void market.refresh([quote.symbol])}>
                  {market.busy ? <Spinner className="size-4" /> : <RefreshCwIcon />}
                  更新到账本
                </Button>
                <Button size="sm" onClick={() => onEntry(quote.symbol)}>记录交易</Button>
              </div>
            </div>
          )}
        </CardPanel>
      </Card>

      <Card className="market-watchlist">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            账本行情
            <Badge variant="secondary" size="sm">{rows.length}</Badge>
          </CardTitle>
          <CardDescription>进行中的战役启动时更新，应用可见时每 5 分钟更新。</CardDescription>
        </CardHeader>
        <CardPanel className="space-y-3">
          <div className="flex justify-end">
            <Button variant="outline" size="sm" disabled={market.busy || !symbols.length || !desktop} onClick={() => void market.refresh()}>
              {market.busy ? <Spinner className="size-4" /> : <RefreshCwIcon />}
              {market.busy ? '更新中…' : '更新持仓行情'}
            </Button>
          </div>
          {market.error && <Alert variant="warning" role="status" className="alert warning">行情更新未全部完成：{market.error}。已有报价保留，可重试或手动校准。</Alert>}
          {rows.length ? (
            <div className="overflow-hidden rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>标的</TableHead>
                    <TableHead className="text-right">账本参考价</TableHead>
                    <TableHead>报价时间 / 来源</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(item => {
                    const price = latestPrice(prices, item);
                    return (
                      <TableRow key={item}>
                        <TableCell>
                          <Button variant="link" size="sm" className="h-auto p-0 font-medium" onClick={() => setSymbol(item)}>{item}</Button>
                        </TableCell>
                        <TableCell className="num text-right">{money(price?.close)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{quoteTime(price)}</TableCell>
                        <TableCell>
                          <Badge variant={price ? (price.quotedAt ? 'secondary' : 'info') : 'outline'} size="sm">
                            {price ? price.quotedAt ? '已缓存 · 可能延迟' : '手动校准' : '待获取'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="xs" disabled={market.busy || !desktop} onClick={() => void market.refresh([item])}>更新报价</Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><SearchIcon /></EmptyMedia>
                <EmptyTitle>还没有标的</EmptyTitle>
                <EmptyDescription>搜索并记录第一笔交易后，自动跟踪持仓行情。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          <p className="market-disclaimer text-xs leading-relaxed text-muted-foreground">
            来源：腾讯财经公开行情。报价可能延迟，仅供成本对照；休市时显示最近成交时点。{market.checkedAt && ` 最近检查 ${market.checkedAt}（本地时间）。`}
          </p>
        </CardPanel>
      </Card>

      <ManualPrice onSaved={onSaved} />
    </div>
  );
}

function ManualPrice({ onSaved }: { onSaved: (message: string) => void }) {
  const [symbol, setSymbol] = useState(''); const [date, setDate] = useState(today());
  const [price, setPrice] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try { await api('set_price', { symbol: symbol.trim(), date, close: Number(price) }); onSaved('手动校准价格已保存。'); }
    catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  return (
    <details className="panel manual-price overflow-hidden rounded-xl border bg-card shadow-xs/5">
      <summary className="flex cursor-pointer items-baseline gap-2 px-4 py-3 text-sm font-medium">
        手动校准价格
        <span className="text-xs font-normal text-muted-foreground">网络不可用或需要历史报价时使用</span>
      </summary>
      <div className="space-y-3 border-t px-4 py-4">
        <p className="text-xs leading-relaxed text-muted-foreground">账本使用日期最新的价格。同日自动更新会替换手动校准价；历史成交记录和成本不受影响。</p>
        {error && <Alert variant="error" role="alert" className="negative">{error}</Alert>}
        <form className="price-form grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={save}>
          <SymbolPicker value={symbol} onChange={setSymbol} label="校准标的" />
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            价格日期
            <Input type="date" required max={today()} value={date} onChange={event => setDate(event.target.value)} />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            每股价格
            <Input type="number" required min="0.0001" step="any" value={price} onChange={event => setPrice(event.target.value)} />
          </label>
          <Button type="submit" className="w-fit" disabled={busy || !desktop}>
            {busy ? <Spinner className="size-4" /> : null}
            {busy ? '保存中…' : '保存校准价'}
          </Button>
        </form>
      </div>
    </details>
  );
}
