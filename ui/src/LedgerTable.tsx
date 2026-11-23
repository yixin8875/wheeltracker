import { useState } from 'react';
import { DownloadIcon, FileSpreadsheetIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NativeSelect } from '@/components/native-select';
import type { Entry } from './types';
import { downloadCsv, labels, money, percent } from './lib';
import { exportLedger } from './export';

const statusTone: Record<string, 'warning' | 'secondary' | 'info' | 'outline'> = {
  open: 'warning',
  closed: 'secondary',
  expired: 'outline',
  assigned: 'info',
};

export function LedgerTable({ entries, openCampaign }: { entries: Entry[]; openCampaign: (id: string) => void }) {
  const [symbol, setSymbol] = useState(''); const [status, setStatus] = useState(''); const [right, setRight] = useState(''); const [from, setFrom] = useState(''); const [until, setUntil] = useState('');
  const filtered = entries.filter(entry => entry.symbol.includes(symbol.trim().toUpperCase()) && (!status || entry.status === status) && (!right || entry.right === right) && (!from || entry.openedAt >= from) && (!until || entry.openedAt <= until));
  const exportRows = () => downloadCsv('wheel-ledger.csv', [
    ['开仓日期', '平仓日期', '标的', '合约', '方向', '手数', '每手股数', '状态', '毛权利金', '平仓成本', '费用', '净权利金', '占用资金', '天数', '年化收益率', '战役'],
    ...filtered.map(entry => [entry.openedAt, entry.closedAt, entry.symbol, entry.contract, entry.right, entry.qty, entry.multiplier, labels[entry.status], entry.premiumGross, entry.closeCost, entry.fees, entry.netPremium, entry.collateral, entry.daysHeld, entry.annualizedReturn, entry.campaignId]),
  ]);
  const realized = filtered.filter(entry => entry.status !== 'open').reduce((sum, entry) => sum + entry.netPremium, 0);
  const open = filtered.filter(entry => entry.status === 'open').reduce((sum, entry) => sum + entry.netPremium, 0);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-heading text-base font-semibold">收租明细</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => exportLedger(filtered)} disabled={!filtered.length}>
            <FileSpreadsheetIcon />
            导出 Excel
          </Button>
          <Button variant="outline" size="sm" onClick={exportRows} disabled={!filtered.length}>
            <DownloadIcon />
            导出 CSV
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          标的
          <Input aria-label="收租标的筛选" placeholder="全部标的" value={symbol} onChange={e => setSymbol(e.target.value)} />
        </label>
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          状态
          <NativeSelect aria-label="收租状态筛选" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            {['open', 'closed', 'expired', 'assigned'].map(value => <option key={value} value={value}>{labels[value]}</option>)}
          </NativeSelect>
        </label>
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          方向
          <NativeSelect aria-label="收租方向筛选" value={right} onChange={e => setRight(e.target.value)}>
            <option value="">Put 与 Call</option>
            <option value="P">Sell Put</option>
            <option value="C">Sell Call</option>
          </NativeSelect>
        </label>
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          开仓自
          <Input aria-label="开仓起始日期" type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </label>
        <label className="grid gap-1.5 text-xs text-muted-foreground">
          至
          <Input aria-label="开仓结束日期" type="date" value={until} onChange={e => setUntil(e.target.value)} />
        </label>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>开仓日期</TableHead>
              <TableHead>合约</TableHead>
              <TableHead className="text-right">手数</TableHead>
              <TableHead className="text-right">每手股数</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">毛权利金</TableHead>
              <TableHead className="text-right">平仓成本</TableHead>
              <TableHead className="text-right">费用</TableHead>
              <TableHead className="text-right">净权利金</TableHead>
              <TableHead className="text-right">占用资金</TableHead>
              <TableHead className="text-right">天数</TableHead>
              <TableHead className="text-right">年化</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map(entry => (
              <TableRow key={entry.id}>
                <TableCell>{entry.openedAt}</TableCell>
                <TableCell>
                  <Button variant="link" size="sm" className="h-auto p-0 font-medium" onClick={() => openCampaign(entry.campaignId)}>{entry.contract}</Button>
                </TableCell>
                <TableCell className="num text-right">{entry.qty}</TableCell>
                <TableCell className="num text-right">{entry.multiplier}</TableCell>
                <TableCell><Badge variant={statusTone[entry.status] ?? 'secondary'} size="sm">{labels[entry.status]}</Badge></TableCell>
                <TableCell className="num text-right">{money(entry.premiumGross)}</TableCell>
                <TableCell className="num text-right">{money(entry.closeCost)}</TableCell>
                <TableCell className="num text-right">{money(entry.fees)}</TableCell>
                <TableCell className={`num text-right ${entry.netPremium < 0 ? 'text-destructive-foreground' : ''}`}>{money(entry.netPremium)}</TableCell>
                <TableCell className="num text-right">{money(entry.collateral)}</TableCell>
                <TableCell className="num text-right">{entry.daysHeld ?? '—'}</TableCell>
                <TableCell className={`num text-right ${entry.annualizedReturn != null && entry.annualizedReturn < 0 ? 'text-destructive-foreground' : ''}`}>{percent(entry.annualizedReturn)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {!filtered.length && <p className="text-sm text-muted-foreground">没有符合筛选条件的收租记录。</p>}
      <div className="table-footer flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
        <span>{filtered.length} 笔记录</span>
        <span>已落袋净收租 <strong className="num font-medium text-foreground">{money(realized)}</strong></span>
        <span>未平仓净权利金 <strong className="num font-medium text-foreground">{money(open)}</strong></span>
      </div>
    </section>
  );
}
