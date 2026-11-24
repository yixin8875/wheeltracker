import { useEffect, useMemo, useState } from 'react';
import { CornerDownLeftIcon, SearchIcon, StickyNoteIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { money } from './lib';
import type { Campaign } from './types';

type Result = {
  key: string;
  label: string;
  hint: string;
  meta?: string;
  run: () => void;
};

export function CommandPalette({ open, onOpenChange, campaigns, onOpenCampaign, onStartEntry }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaigns: Campaign[];
  onOpenCampaign: (campaignId: string) => void;
  onStartEntry: (symbol: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const results = useMemo<Result[]>(() => {
    const text = query.trim().toUpperCase();
    const matches = campaigns
      .filter(campaign => !text || campaign.symbol.includes(text))
      .sort((left, right) => {
        const rank = (campaign: Campaign) => campaign.status === 'active' ? 0 : 1;
        return rank(left) - rank(right)
          || (left.nextOption?.expiry ?? '9999-12-31').localeCompare(right.nextOption?.expiry ?? '9999-12-31')
          || left.symbol.localeCompare(right.symbol);
      })
      .slice(0, 8);
    const items: Result[] = matches.map(campaign => ({
      key: `campaign-${campaign.id}`,
      label: campaign.symbol,
      hint: campaign.status === 'active'
        ? campaign.nextOption ? `${campaign.nextOption.openQty} 手 ${campaign.nextOption.strike}${campaign.nextOption.right} · ${campaign.nextOption.expiry} 到期` : `进行中 · ${campaign.startedAt} 开始`
        : `已结束 · 已实现 ${money(campaign.realizedPnl)}`,
      meta: campaign.costB != null ? `B 轨 ${money(campaign.costB)}` : campaign.premiumRealized ? `已落袋 ${money(campaign.premiumRealized)}` : undefined,
      run: () => {
        onOpenCampaign(campaign.id);
        onOpenChange(false);
      },
    }));
    if (text) {
      items.push({
        key: 'entry',
        label: `记一笔 ${text}`,
        hint: '以该标的打开录入表单',
        run: () => {
          onStartEntry(text);
          onOpenChange(false);
        },
      });
    }
    return items;
  }, [campaigns, onOpenChange, onOpenCampaign, onStartEntry, query]);

  useEffect(() => { setActive(0); }, [query]);

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(index => Math.min(index + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(index => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      results[active]?.run();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="command-palette max-w-xl p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-base"><SearchIcon className="size-4 text-muted-foreground" />快速搜索</DialogTitle>
          <DialogDescription>搜索当前账户的标的与战役 · ↑↓ 选择，Enter 打开，Esc 关闭</DialogDescription>
        </DialogHeader>
        <div className="p-3">
          <Input
            aria-label="全局搜索"
            autoFocus
            value={query}
            placeholder="输入标的或战役代码，例如 AAPL…"
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div role="listbox" aria-label="搜索结果" className="mt-2 max-h-80 space-y-1 overflow-auto">
            {results.map((result, index) => (
              <button
                key={result.key}
                type="button"
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={result.run}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left ${index === active ? 'bg-muted' : 'hover:bg-muted/60'}`}
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <strong className="font-heading text-sm font-semibold">{result.label}</strong>
                    {result.key === 'entry' && <Badge variant="secondary" size="sm">录入</Badge>}
                    {result.meta && <span className="num text-xs text-muted-foreground">{result.meta}</span>}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{result.hint}</span>
                </span>
                {result.key === 'entry'
                  ? <CornerDownLeftIcon className="size-4 shrink-0 text-muted-foreground" />
                  : <StickyNoteIcon className="size-4 shrink-0 text-muted-foreground" />}
              </button>
            ))}
            {!results.length && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">没有匹配的标的或战役。</p>
            )}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
