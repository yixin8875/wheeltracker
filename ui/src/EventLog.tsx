import { useState } from 'react';
import { DownloadIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NativeSelect } from '@/components/native-select';
import { downloadCsv, labels, money } from './lib';
import type { EventRow } from './types';

const KINDS = ['option_open_short', 'option_close', 'option_expire', 'option_assign', 'shares_buy', 'shares_sell', 'dividend', 'fee', 'interest', 'adjustment', 'cash_deposit', 'cash_withdrawal', 'stock_split'];
const CASH_KINDS = new Set(['cash_deposit', 'cash_withdrawal']);

function quantityLabel(event: EventRow) {
  if (event.kind === 'stock_split') return `${event.splitNumerator} : ${event.splitDenominator}`;
  if (event.kind === 'fee' || event.kind === 'interest' || event.kind === 'adjustment' || CASH_KINDS.has(event.kind)) return '—';
  return String(event.qty);
}

function priceLabel(event: EventRow) {
  if (['option_open_short', 'option_close', 'shares_buy', 'shares_sell', 'dividend'].includes(event.kind)) return money(event.price);
  return '—';
}

function feeLabel(event: EventRow) {
  if (event.kind === 'stock_split' || event.kind === 'fee' || event.kind === 'interest' || event.kind === 'adjustment' || CASH_KINDS.has(event.kind)) return '—';
  return money(event.fees);
}

function amountLabel(event: EventRow) {
  if (event.kind === 'stock_split') return event.splitCashInLieu != null ? `零股补偿 ${money(event.splitCashInLieu)}` : '—';
  if (event.kind === 'cash_deposit') return `入金 ${money(event.amount)}`;
  if (event.kind === 'cash_withdrawal') return `出金 ${money(event.amount)}`;
  if (event.kind === 'fee' || event.kind === 'interest' || event.kind === 'adjustment') return money(event.amount);
  return '—';
}

export function EventLog({ events, onUndo, onEdit }: { events: EventRow[]; onUndo: (id: string) => void; onEdit: (event: EventRow) => void }) {
  const [symbol, setSymbol] = useState('');
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const filtered = events.filter(event =>
    event.symbol.includes(symbol.trim().toUpperCase())
    && (!kind || event.kind === kind)
    && (!from || event.date >= from)
    && (!until || event.date <= until)
  );

  function exportRows() {
    downloadCsv('wheel-events.csv', [
      ['id', 'date', 'kind', 'symbol', 'qty', 'multiplier', 'split_numerator', 'split_denominator', 'split_cash_in_lieu', 'price', 'fees', 'amount', 'expiry', 'strike', 'right', 'note'],
      ...filtered.map(event => [event.id, event.date, event.kind, event.symbol, event.qty, event.multiplier, event.splitNumerator, event.splitDenominator, event.splitCashInLieu, event.price, event.fees, event.amount, event.expiry, event.strike, event.right, event.note]),
    ]);
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-heading text-base font-semibold">交易事件日志</h2>
          <p className="text-xs text-muted-foreground">{filtered.length} / {events.length} 笔 · 修改与撤销前都会重新校验后续交易</p>
        </div>
        <Button variant="outline" size="sm" onClick={exportRows} disabled={!filtered.length}>
          <DownloadIcon />
          导出交易 CSV
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          标的
          <Input aria-label="事件标的筛选" placeholder="全部标的" value={symbol} onChange={event => setSymbol(event.target.value)} />
        </label>
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          类型
          <NativeSelect aria-label="事件类型筛选" value={kind} onChange={event => setKind(event.target.value)}>
            <option value="">全部类型</option>
            {KINDS.map(value => <option key={value} value={value}>{labels[value] ?? value}</option>)}
          </NativeSelect>
        </label>
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          日期自
          <Input aria-label="事件起始日期" type="date" value={from} onChange={event => setFrom(event.target.value)} />
        </label>
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          至
          <Input aria-label="事件结束日期" type="date" value={until} onChange={event => setUntil(event.target.value)} />
        </label>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>日期</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>标的 / 合约</TableHead>
              <TableHead>数量 / 拆股比例</TableHead>
              <TableHead>每股价格</TableHead>
              <TableHead>费用</TableHead>
              <TableHead>金额 / 零股补偿</TableHead>
              <TableHead>备注</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...filtered].reverse().map(event => (
              <TableRow key={event.id}>
                <TableCell>{event.date}</TableCell>
                <TableCell>{labels[event.kind] ?? event.kind}</TableCell>
                <TableCell>{event.symbol || (event.kind === 'interest' || event.kind === 'fee' || CASH_KINDS.has(event.kind) ? '账户级' : '账户')} {event.expiry} {event.strike}{event.right}{event.multiplier && event.multiplier !== 100 ? ` · ${event.multiplier} 股/手` : ''}</TableCell>
                <TableCell className="num">{quantityLabel(event)}</TableCell>
                <TableCell className="num">{priceLabel(event)}</TableCell>
                <TableCell className="num">{feeLabel(event)}</TableCell>
                <TableCell className="num">{amountLabel(event)}</TableCell>
                <TableCell className="note-cell max-w-[230px] whitespace-normal">{event.note}</TableCell>
                <TableCell>
                  <div className="row-actions flex gap-1.5">
                    <Button variant="outline" size="xs" onClick={() => onEdit(event)}>修改</Button>
                    <Button variant="ghost" size="xs" onClick={() => onUndo(event.id)}>撤销</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {!filtered.length && <p className="text-sm text-muted-foreground">{events.length ? '没有符合筛选条件的事件。' : '暂无交易记录。'}</p>}
      <p className="footnote text-xs leading-relaxed text-muted-foreground">
        修改会保留原记录的 ID 与序号，并在保存前重新回放整本账；若后续交易依赖这条记录，会拒绝修改并提示先撤销后续交易。撤销不会物理删除记录：原始数据仍保留在数据库中用于审计，但撤销后不再出现在当前界面、CSV 或 JSON 导出中。
      </p>
    </section>
  );
}
