import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { api, desktop, money, percent, today } from './lib';
import type { MarketQuote, Price, QuoteRefresh } from './types';
import { SymbolPicker } from './SymbolPicker';

const validSymbol = /^[A-Z][A-Z0-9.-]{0,19}$/;
export function latestPrice(prices: Price[], symbol: string) {
  return prices.filter(quote => quote.symbol === symbol).sort((a, b) => b.date.localeCompare(a.date))[0];
}
export function quoteTime(quote?: Price) {
  if (!quote) return '尚无报价';
  const stamp = quote.quotedAt ? quote.quotedAt.slice(5, 16) : quote.date.slice(5);
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
  return <div className="quote-reference" aria-live="polite">
    {busy ? <span>正在读取 {symbol} 标的参考价…</span> : quote ? <><span>标的参考价 <strong>{money(quote.price)}</strong></span><small>{quote.quotedAt} 美东 · {quote.source} · 可能延迟</small><small>参考价不填入成交价或期权权利金。</small></> : error ? <><span>标的参考价不可用：{error}</span><button type="button" className="text-button" onClick={retry}>重试报价</button></> : <span>在桌面应用中查看标的参考价。</span>}
  </div>;
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
  return <>
    <section className="market-search"><div className="market-intro"><Search size={18}/><div><h2>查找标的</h2><p className="muted">搜索美股或 ETF，查看价格后直接记账。</p></div></div>
      <SymbolPicker value={symbol} onChange={setSymbol} label="搜索美股或 ETF"/>
      {busy && <p className="market-search-status" role="status">正在读取标的报价…</p>}
      {error && <p className="market-search-status negative" role="alert">{error} <button onClick={retry}>重试查询</button></p>}
      {quote && <div className="market-result"><div><h3>{quote.symbol} <span>{quote.name}</span></h3><p><strong>{money(quote.price)}</strong>{quote.changePercent != null && <span className={quote.changePercent >= 0 ? 'positive' : 'negative'}>{quote.changePercent > 0 ? '+' : ''}{percent(quote.changePercent / 100)}</span>}</p><small>{quote.quotedAt.slice(5, 16)} 美东 · {quote.source} · USD · 可能延迟</small></div><div className="toolbar"><button disabled={market.busy || !desktop} onClick={() => void market.refresh([quote.symbol])}>更新到账本</button><button className="primary" onClick={() => onEntry(quote.symbol)}>记录交易</button></div></div>}
    </section>
    <section className="panel market-watchlist"><div className="section-heading"><div><h2>账本行情 <span className="count">{rows.length}</span></h2><p className="muted">进行中的战役启动时更新，应用可见时每 5 分钟更新。</p></div><button disabled={market.busy || !symbols.length || !desktop} onClick={() => void market.refresh()}><RefreshCw size={16} className={market.busy ? 'spinning' : ''}/>{market.busy ? '更新中…' : '更新持仓行情'}</button></div>
      {market.error && <p role="status" className="alert warning">行情更新未全部完成：{market.error}。已有报价保留，可重试或手动校准。</p>}
      <div className="table-wrap"><table><thead><tr><th>标的</th><th>账本参考价</th><th>报价时间 / 来源</th><th>状态</th><th>操作</th></tr></thead><tbody>{rows.map(item => { const price = latestPrice(prices, item); return <tr key={item}><td><button className="text-button" onClick={() => setSymbol(item)}>{item}</button></td><td>{money(price?.close)}</td><td>{quoteTime(price)}</td><td><span className="badge">{price ? price.quotedAt ? '已缓存 · 可能延迟' : '手动校准' : '待获取'}</span></td><td><button disabled={market.busy || !desktop} onClick={() => void market.refresh([item])}>更新报价</button></td></tr>; })}</tbody></table></div>
      {!rows.length && <p className="empty">还没有标的。搜索并记录第一笔交易后，自动跟踪持仓行情。</p>}
      <p className="market-disclaimer">来源：腾讯财经公开行情。报价可能延迟，仅供成本对照；休市时显示最近成交时点。{market.checkedAt && ` 最近检查 ${market.checkedAt}（本地时间）。`}</p>
    </section>
    <ManualPrice onSaved={onSaved}/>
  </>;
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
  return <details className="panel manual-price"><summary>手动校准价格 <span>网络不可用或需要历史报价时使用</span></summary><p className="muted">账本使用日期最新的价格。同日自动更新会替换手动校准价；历史成交记录和成本不受影响。</p>{error && <p role="alert" className="negative">{error}</p>}<form className="price-form" onSubmit={save}><SymbolPicker value={symbol} onChange={setSymbol} label="校准标的"/><label>价格日期<input type="date" required max={today()} value={date} onChange={event => setDate(event.target.value)}/></label><label>每股价格<input type="number" required min="0.0001" step="any" value={price} onChange={event => setPrice(event.target.value)}/></label><button className="primary" disabled={busy || !desktop}>{busy ? '保存中…' : '保存校准价'}</button></form></details>;
}
