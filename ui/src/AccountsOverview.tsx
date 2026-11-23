import { TriangleAlertIcon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { money, percent } from './lib';
import type { AllAccountsOverview, OverviewAccount } from './types';

function coverageTone(value: number | null | undefined) {
  if (value == null) return '';
  return value < 1 ? 'negative text-destructive-foreground' : 'positive text-success-foreground';
}

function cashLabel(account: OverviewAccount) {
  return account.cashTracked ? money(account.accountCash) : '—';
}

function Summary({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: string }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <strong className={`num text-xl font-semibold tracking-tight ${tone ?? ''}`}>{value}</strong>
      <small className="text-xs text-muted-foreground">{hint}</small>
    </div>
  );
}

export function AccountsOverview({ overview, onOpenAccount }: {
  overview: AllAccountsOverview;
  onOpenAccount: (id: string) => void;
}) {
  const { accounts, totals } = overview;
  return (
    <Card className="overview">
      <CardHeader>
        <CardTitle className="text-base">汇总</CardTitle>
        <CardDescription>{overview.asOf} · 只读 · 不合并持仓或成本</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-4">
        <div className="overview-summary grid gap-4 rounded-xl border bg-muted/40 p-4 sm:grid-cols-2 xl:grid-cols-5">
          <Summary label="账本现金" value={money(totals.accountCash)} hint={`${totals.cashTrackedAccounts} 个账户已记录入金 / 出金`} />
          <Summary label="总 Put 资金义务" value={money(totals.collateral)} hint={`全部 ${totals.accountCount} 个可用账户`} />
          <Summary label="综合覆盖率" value={percent(totals.cashCoverage)} hint={`已记录现金账户的 Put 义务 ${money(totals.trackedCollateral)}`} tone={coverageTone(totals.cashCoverage)} />
          <Summary label="现金缺口" value={money(totals.cashShortfall)} hint="各账户缺口之和，盈余不抵扣" tone={totals.cashShortfall > 0 ? 'negative text-destructive-foreground' : ''} />
          <Summary label="未平仓净权利金" value={money(totals.premiumOpen)} hint={`${totals.openContracts} 手 · ${totals.activeCampaigns} 个进行中战役`} />
        </div>

        {totals.untrackedPutAccounts > 0 && (
          <Alert variant="warning" role="status" className="alert warning">
            <TriangleAlertIcon />
            有 {totals.untrackedPutAccounts} 个账户持有未平仓 Put，但尚未记录入金 / 出金，这些义务未计入综合覆盖率。请先补录期初入金，再判断整体资金是否足够。
          </Alert>
        )}
        {totals.untrackedPutAccounts === 0 && totals.untrackedAccounts > 0 && (
          <p className="footnote text-xs leading-relaxed text-muted-foreground">{totals.untrackedAccounts} 个账户未记录入金 / 出金，未计入「账本现金」；其交易现金流净额仍在账户行显示。</p>
        )}

        {!accounts.length ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>没有可用账户</EmptyTitle>
              <EmptyDescription>可在「设置 → 账户」新建账户。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <Table className="overview-table">
              <TableHeader>
                <TableRow>
                  <TableHead>账户</TableHead>
                  <TableHead className="text-right">账本现金</TableHead>
                  <TableHead className="text-right">Put 义务</TableHead>
                  <TableHead className="text-right">覆盖率</TableHead>
                  <TableHead className="text-right">缺口</TableHead>
                  <TableHead className="text-right">未平仓净权利金</TableHead>
                  <TableHead>持仓</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map(account => (
                  <TableRow key={account.id} className={account.cashTracked ? '' : 'overview-row untracked'}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="font-medium">{account.name}</strong>
                        {!account.cashTracked && <Badge variant="outline" size="sm" className="account-tag">未记录现金</Badge>}
                      </div>
                      <small className="block text-xs text-muted-foreground">{account.activeCampaigns} 个进行中战役 · 持股 {account.sharesHeld} 股</small>
                    </TableCell>
                    <TableCell className="num text-right">
                      {cashLabel(account)}
                      {!account.cashTracked && <small className="block text-xs text-muted-foreground">交易净额 {money(account.accountCash)}</small>}
                    </TableCell>
                    <TableCell className="num text-right">{money(account.collateral)}</TableCell>
                    <TableCell className={`num text-right ${coverageTone(account.cashCoverage)}`}>{percent(account.cashCoverage)}</TableCell>
                    <TableCell className={`num text-right ${account.cashShortfall > 0 ? 'negative text-destructive-foreground' : ''}`}>{account.cashTracked ? money(account.cashShortfall) : '—'}</TableCell>
                    <TableCell className="num text-right">{money(account.premiumOpen)}</TableCell>
                    <TableCell className="num">{account.openPositions} 个 · {account.openContracts} 手</TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="xs" onClick={() => onOpenAccount(account.id)}>打开账户</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <p className="footnote text-xs leading-relaxed text-muted-foreground">只汇总现金、义务与未平仓权利金，不合并账户间的持仓、成本或报表；已归档账户不参与统计。现金只反映账本事件，不含利息、在途资金或融资额度。</p>
      </CardPanel>
    </Card>
  );
}
