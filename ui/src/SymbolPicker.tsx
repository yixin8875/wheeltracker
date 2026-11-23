import { useEffect, useId, useState } from 'react';
import { SearchIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api, desktop } from './lib';
import type { SymbolMatch } from './types';

const common: SymbolMatch[] = [
  ['AAPL', 'Apple 苹果'], ['MSFT', 'Microsoft 微软'], ['NVDA', 'NVIDIA 英伟达'],
  ['TSLA', 'Tesla 特斯拉'], ['AMZN', 'Amazon 亚马逊'], ['GOOGL', 'Alphabet 谷歌'],
  ['META', 'Meta'], ['SPY', 'SPDR S&P 500 ETF'], ['QQQ', 'Invesco QQQ ETF'],
  ['IWM', 'iShares Russell 2000 ETF'], ['VOO', 'Vanguard S&P 500 ETF'],
  ['AMD', 'Advanced Micro Devices'], ['BRK.B', 'Berkshire Hathaway 伯克希尔'],
  ['COST', 'Costco 好市多'], ['AVGO', 'Broadcom 博通'], ['PLTR', 'Palantir'],
].map(([symbol, name]) => ({ symbol, name, exchange: '美股' }));

export function SymbolPicker({ value, onChange, label = '标的代码', autoFocus = false, required = true }: {
  value: string; onChange: (symbol: string) => void; label?: string; autoFocus?: boolean; required?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<SymbolMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState(-1);
  const query = value.trim();
  const local = common.filter(item => `${item.symbol} ${item.name}`.toLowerCase().includes(query.toLowerCase()));
  const results = [...remote, ...local.filter(item => !remote.some(hit => hit.symbol === item.symbol))].slice(0, 10);
  useEffect(() => {
    let cancelled = false;
    setRemote([]); setError(''); setActive(-1); setLoading(false);
    if (!open || !query || !desktop) return;
    setLoading(true);
    const timer = setTimeout(() => {
      api<SymbolMatch[]>('search_symbols', { query }).then(result => {
        if (!cancelled) setRemote(result);
      }).catch(failure => { if (!cancelled) setError(String(failure)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, open]);
  function choose(symbol: string) { onChange(symbol); setOpen(false); setActive(-1); }

  return (
    <div
      className="symbol-picker relative grid gap-1.5"
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    >
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="relative flex items-center">
        <SearchIcon className="pointer-events-none absolute start-2.5 size-4 text-muted-foreground" aria-hidden="true" />
        <Input
          id={id}
          className="ps-8.5"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-activedescendant={open && active >= 0 && results[active] ? `${id}-${active}` : undefined}
          autoFocus={autoFocus}
          required={required}
          maxLength={80}
          pattern="[A-Za-z][A-Za-z0-9.\-]{0,19}"
          title="请选择搜索结果，或填写完整美股代码"
          autoComplete="off"
          placeholder="代码或公司名称"
          value={value}
          onFocus={() => setOpen(true)}
          onChange={event => { onChange(event.target.value.toUpperCase()); setOpen(true); setRemote([]); setActive(-1); }}
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); setOpen(true);
              setActive(index => results.length ? event.key === 'ArrowDown' ? (index + 1) % results.length : (index <= 0 ? results.length - 1 : index - 1) : -1);
            }
            if (event.key === 'Enter' && open && active >= 0 && results[active]) { event.preventDefault(); choose(results[active].symbol); }
          }}
        />
      </div>
      {open && (
        <div className="symbol-menu absolute top-full z-50 mt-1 w-full overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg/8">
          <p className="symbol-menu-caption border-b px-3 py-2 text-xs text-muted-foreground">{query ? '搜索结果' : '常用美股与 ETF'}</p>
          <ul id={`${id}-list`} role="listbox" aria-label="标的搜索结果" className="max-h-72 overflow-y-auto p-1">
            {results.map((item, index) => (
              <li
                id={`${id}-${index}`}
                role="option"
                aria-selected={active === index}
                key={item.symbol}
                onMouseDown={event => event.preventDefault()}
                onClick={() => choose(item.symbol)}
                onMouseEnter={() => setActive(index)}
                className="flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
              >
                <strong className="num font-medium">{item.symbol}</strong>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.name}</span>
                <small className="text-xs text-muted-foreground">{item.exchange}</small>
              </li>
            ))}
          </ul>
          {loading && <p role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><Spinner className="size-3" />正在查询…</p>}
          {!loading && !results.length && <p className="px-3 py-2 text-xs text-muted-foreground">未找到匹配标的，可直接输入完整美股代码。</p>}
          {error && <p role="status" className="negative px-3 py-2 text-xs text-destructive">在线搜索不可用：{error}。仍可选择常用标的或直接输入代码。</p>}
          {!desktop && <p className="px-3 py-2 text-xs text-muted-foreground">桌面应用支持在线搜索。</p>}
        </div>
      )}
    </div>
  );
}
