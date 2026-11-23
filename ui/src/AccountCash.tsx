import { useEffect, useState } from 'react';
import { ScaleIcon, WalletIcon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, labels, money, percent } from './lib';
import type { CashMovement, Summary } from './types';

/** Account cash is derived from the event stream, so it is only a real cash
 * balance once the user has recorded at least one deposit or withdrawal. */
export function AccountCashPanel({ summary, onEntry, onReconcile }: {
  summary: Summary;
  onEntry: (kind: 'cash_deposit' | 'cash_withdrawal') => void;
  onReconcile: () => void;
}) {
  const cash = summary.accountCash ?? 0;
  const deposits = summary.cashDeposits ?? 0;
  const withdrawals = summary.cashWithdrawals ?? 0;
  const collateral = summary.collateral ?? 0;
  const tracked = summary.cashTracked ?? false;
  const coverage = summary.cashCoverage;
  const shortfall = summary.cashShortfall ?? 0;
  return (
    <Card className="cash-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><WalletIcon className="size-4 text-muted-foreground" />账户现金与 Put 覆盖</CardTitle>
        <CardDescription>由全部交易现金流与入金 / 出金推导</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => onEntry('cash_deposit')}>记录入金</Button>
          <Button variant="outline" size="sm" onClick={() => onEntry('cash_withdrawal')}>记录出金</Button>
          <Button variant="ghost" size="sm" onClick={onReconcile}><ScaleIcon />与券商对账</Button>
        </div>
        <div className="summary-strip cash-summary grid gap-4 rounded-xl border bg-muted/40 p-4 sm:grid-cols-3">
          <div className="grid gap-0.5">
            <span className="text-xs text-muted-foreground">{tracked ? '账户现金' : '交易现金流净额'}</span>
            <strong className={`num text-2xl font-semibold tracking-tight ${cash < 0 ? 'negative text-destructive-foreground' : ''}`}>{money(cash)}</strong>
            <small className="text-xs text-muted-foreground">累计入金 {money(deposits)} · 累计出金 {money(withdrawals)}</small>
          </div>
          <div className="grid gap-0.5">
            <span className="text-xs text-muted-foreground">Put 资金义务</span>
            <strong className="num text-2xl font-semibold tracking-tight">{money(collateral)}</strong>
            <small className="text-xs text-muted-foreground">行权价 × 每手股数 × 未平仓手数</small>
          </div>
          <div className="grid gap-0.5">
            <span className="text-xs text-muted-foreground">现金覆盖率</span>
            <strong className={`num text-2xl font-semibold tracking-tight ${coverage == null ? '' : coverage < 1 ? 'negative text-destructive-foreground' : 'positive text-success-foreground'}`}>{percent(coverage ?? null)}</strong>
            <small className="text-xs text-muted-foreground">{!tracked ? '记录入金后计算' : collateral <= 0 ? '当前没有未平仓 Put' : coverage != null && coverage < 1 ? `缺口 ${money(shortfall)}` : '现金足以承接全部 Put 指派'}</small>
          </div>
        </div>
        {!tracked && <p className="footnote warning-text text-xs leading-relaxed text-warning-foreground">尚未记录入金 / 出金，账户现金只代表交易现金流，不含期初余额，也不能据此判断券商现金是否足够。补录历史账本时，先记录一笔期初入金。</p>}
        {tracked && cash < 0 && <p className="footnote negative text-xs leading-relaxed text-destructive-foreground">账户现金为负：可能漏记了入金，或漏记了卖出 / 分红等现金流入。可先用「与券商对账」定位差额。</p>}
        <p className="footnote text-xs leading-relaxed text-muted-foreground">账户现金 = 全部交易现金流 + 累计入金 − 累计出金；只反映账本已记录的事件，不包含未记录的交易、利息或券商费用。入金 / 出金不计入战役收益，也不影响 A / B / C′ 成本。</p>
      </CardPanel>
    </Card>
  );
}

export function ReconcileModal({ accountId, summary, onClose }: {
  accountId: string;
  summary: Summary;
  onClose: () => void;
}) {
  const [movements, setMovements] = useState<CashMovement[] | null>(null);
  const [error, setError] = useState('');
  const [broker, setBroker] = useState('');
  const cash = summary.accountCash ?? 0;
  const tracked = summary.cashTracked ?? false;

  useEffect(() => {
    let cancelled = false;
    api<CashMovement[]>('cash_movements', { accountId, limit: 60 })
      .then(list => { if (!cancelled) setMovements(list); })
      .catch(failure => { if (!cancelled) setError(String(failure)); });
    return () => { cancelled = true; };
  }, [accountId]);

  const normalized = broker.replace(/[,$\s]/g, '');
  const brokerValue = normalized === '' ? null : Number(normalized);
  const difference = brokerValue != null && Number.isFinite(brokerValue) ? brokerValue - cash : null;

  return (
    <div className="modal-backdrop fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm">
      <section role="dialog" aria-modal="true" aria-labelledby="reconcile-title" className="modal wide w-full max-w-3xl space-y-4 rounded-2xl border bg-card p-5 shadow-xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="reconcile-title" className="font-heading text-lg font-semibold">与券商对账</h2>
            <span className="text-xs text-muted-foreground">只读对照，不会修改账本</span>
          </div>
          <Button variant="outline" size="sm" onClick={onClose}>关闭</Button>
        </div>
        <div className="reconcile-grid grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            券商显示的现金余额（USD）
            <Input autoFocus type="text" inputMode="decimal" placeholder="例如 12,345.67" value={broker} onChange={event => setBroker(event.target.value)} />
          </label>
          <dl className="scenario-values reconcile-values grid grid-cols-3 gap-3 rounded-xl border bg-muted/40 p-3">
            <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">账本现金</dt><dd className="num text-sm font-medium">{money(cash)}</dd></div>
            <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">券商现金</dt><dd className="num text-sm font-medium">{brokerValue != null && Number.isFinite(brokerValue) ? money(brokerValue) : '—'}</dd></div>
            <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">差额</dt><dd className={`num text-sm font-medium ${difference == null ? '' : difference === 0 ? 'positive text-success-foreground' : 'negative text-destructive-foreground'}`}>{difference == null ? '—' : money(difference)}</dd></div>
          </dl>
        </div>
        {!tracked && <Alert variant="warning" role="status" className="alert warning">账本尚未记录入金 / 出金，账本现金不含期初余额；请先补录期初入金，对账差额才有意义。</Alert>}
        {difference != null && <p className={`footnote text-xs leading-relaxed ${difference === 0 ? 'positive text-success-foreground' : 'negative text-destructive-foreground'}`}>{difference === 0 ? '账本现金与券商一致。' : '差额 = 券商现金 − 账本现金。正数通常表示账本漏记了入金或现金流入；负数通常表示漏记了出金或现金流出，或多记了入金。'}</p>}
        {error && <p className="negative text-sm text-destructive-foreground" role="alert">{error}</p>}
        <h3 className="font-heading text-sm font-semibold">最近的现金变动</h3>
        {movements == null && !error ? (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3" />正在读取现金变动…</p>
        ) : movements && movements.length ? (
          <div className="cash-movements max-h-[46vh] overflow-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>标的 / 备注</TableHead>
                  <TableHead className="text-right">现金变动</TableHead>
                  <TableHead className="text-right">变动后余额</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movements.map((movement, index) => (
                  <TableRow key={`${movement.date}-${index}`}>
                    <TableCell className="num">{movement.date}</TableCell>
                    <TableCell>{labels[movement.kind] ?? movement.kind}</TableCell>
                    <TableCell>{[movement.symbol, movement.note].filter(Boolean).join(' · ') || '账户级'}</TableCell>
                    <TableCell className={`num text-right ${movement.amount < 0 ? 'negative text-destructive-foreground' : 'positive text-success-foreground'}`}>{money(movement.amount)}</TableCell>
                    <TableCell className="num text-right">{money(movement.balanceAfter)}</TableCell>
                    </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : movements && !movements.length ? (
          <p className="text-sm text-muted-foreground">账本还没有产生现金变动的事件。</p>
        ) : null}
        <p className="footnote text-xs leading-relaxed text-muted-foreground">现金变动按美东交易日排序，展示最近 60 笔；到期作废不产生现金，因此不在列表中。对账结果不会保存。</p>
      </section>
    </div>
  );
}
