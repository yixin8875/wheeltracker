import { TriangleAlertIcon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { money, percent } from './lib';
import type { AllHoldings } from './types';

function tone(value: number | null | undefined) {
  if (value == null || value === 0) return '';
  return value > 0 ? 'positive text-success-foreground' : 'negative text-destructive-foreground';
}

function pnlLabel(value: number | null | undefined) {
  if (value == null) return '—';
  return `${value > 0 ? '+' : ''}${money(value)}`;
}

function Summary({ label, value, hint, tone: toneClass }: { label: string; value: string; hint: string; tone?: string }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <strong className={`num text-xl font-semibold tracking-tight ${toneClass ?? ''}`}>{value}</strong>
      <small className="text-xs text-muted-foreground">{hint}</small>
    </div>
  );
}

export function AllHoldingsPage({ view, onOpenHolding }: {
  view: AllHoldings;
  onOpenHolding: (accountId: string, campaignId: string) => void;
}) {
  const { holdings, options, totals } = view;
  return (
    <Card className="overview">
      <CardHeader>
        <CardTitle className="text-base">持仓汇总</CardTitle>
        <CardDescription>{view.asOf} · 只读 · 各账户分别列示，不合并持仓</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-5">
        <div className="overview-summary holdings-summary grid gap-4 rounded-xl border bg-muted/40 p-4 sm:grid-cols-2 xl:grid-cols-5">
          <Summary label="持仓市值" value={money(totals.marketValue)} hint={`${totals.pricedHoldings} 个持仓有参考价 · 共 ${totals.totalShares} 股`} />
          <Summary label="浮动盈亏" value={pnlLabel(totals.unrealizedPnl)} hint={`${percent(totals.unrealizedPct)} · 按实际成本口径`} tone={tone(totals.unrealizedPnl)} />
          <Summary label="实际成本总额" value={money(totals.costBasis)} hint="已扣除这些持仓所属战役的累计落袋净权利金" />
          <Summary label="已落袋净权利金" value={money(totals.premiumRealized)} hint={`未平仓净权利金 ${money(totals.premiumOpen)}`} />
          <Summary label="未平仓 Put 义务" value={money(totals.optionCollateral)} hint={`${totals.optionCount} 个合约 · ${totals.openContracts} 手`} />
        </div>

        {totals.unpricedHoldings > 0 && (
          <Alert variant="warning" role="status" className="alert warning">
            <TriangleAlertIcon />
            有 {totals.unpricedHoldings} 个持仓尚无参考价，未计入持仓市值、实际成本总额与浮动盈亏。请先在「行情」页更新报价。
          </Alert>
        )}

        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-heading text-sm font-semibold">股票持仓</h2>
            <span className="text-xs text-muted-foreground">{holdings.length} 个持仓</span>
          </div>
          {!holdings.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>全部账户暂无股票持仓</EmptyTitle>
                <EmptyDescription>记录买入或被指派的交易后，持仓会显示在这里。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-hidden rounded-xl border">
              <Table className="overview-table holdings-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>账户</TableHead>
                    <TableHead>标的</TableHead>
                    <TableHead className="text-right">股数</TableHead>
                    <TableHead className="text-right">实际成本 / 股</TableHead>
                    <TableHead className="text-right">纯股票成本 / 股</TableHead>
                    <TableHead className="text-right">参考价</TableHead>
                    <TableHead className="text-right">持仓盈亏</TableHead>
                    <TableHead className="text-right">盈亏率</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {holdings.map(holding => (
                    <TableRow key={`${holding.accountId}:${holding.campaignId}`}>
                      <TableCell>
                        <strong className="block font-medium">{holding.accountName}</strong>
                        <small className="block text-xs text-muted-foreground">已落袋 {money(holding.premiumRealized)}</small>
                      </TableCell>
                      <TableCell>
                        <strong className="block font-medium">{holding.symbol}</strong>
                        <small className="block text-xs text-muted-foreground">{holding.startedAt} 开始</small>
                      </TableCell>
                      <TableCell className="num text-right">{holding.shares}</TableCell>
                      <TableCell className="num text-right">
                        <strong className="block font-medium">{money(holding.costB)}</strong>
                        {holding.costC != null && <small className="block text-xs text-muted-foreground">含未平仓 {money(holding.costC)}</small>}
                      </TableCell>
                      <TableCell className="num text-right">{money(holding.costA)}</TableCell>
                      <TableCell className="num text-right">
                        {money(holding.price)}
                        {holding.price == null && <Badge variant="outline" size="sm" className="account-tag ms-1">无参考价</Badge>}
                      </TableCell>
                      <TableCell className={`num text-right ${tone(holding.unrealizedPnl)}`}>
                        {pnlLabel(holding.unrealizedPnl)}
                        {holding.costBasis != null && <small className="block text-xs text-muted-foreground">成本 {money(holding.costBasis)}</small>}
                      </TableCell>
                      <TableCell className={`num text-right ${tone(holding.unrealizedPnl)}`}>{percent(holding.unrealizedPct)}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="xs" onClick={() => onOpenHolding(holding.accountId, holding.campaignId)}>打开战役</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-heading text-sm font-semibold">未平仓期权</h2>
            <span className="text-xs text-muted-foreground">按到期日排序 · 全部账户</span>
          </div>
          {!options.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>全部账户暂无未平仓期权</EmptyTitle>
                <EmptyDescription>卖出 Put / Call 后，未了结的合约会显示在这里。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-hidden rounded-xl border">
              <Table className="overview-table holdings-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>账户</TableHead>
                    <TableHead>合约</TableHead>
                    <TableHead className="text-right">手数</TableHead>
                    <TableHead className="text-right">每股净权利金</TableHead>
                    <TableHead>到期日</TableHead>
                    <TableHead>剩余天数</TableHead>
                    <TableHead className="text-right">Put 义务</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {options.map(option => (
                    <TableRow key={`${option.accountId}:${option.contract}`}>
                      <TableCell>{option.accountName}</TableCell>
                      <TableCell className="font-medium">{option.contract}</TableCell>
                      <TableCell className="num text-right">{option.openQty}</TableCell>
                      <TableCell className="num text-right">{money(option.avgCredit)}</TableCell>
                      <TableCell className="num">{option.expiry}</TableCell>
                      <TableCell>
                        <span className={option.daysLeft < 0 ? 'text-destructive-foreground' : option.daysLeft <= 7 ? 'warning-text text-warning-foreground' : ''}>
                          {option.daysLeft < 0 ? `已过期 ${-option.daysLeft} 天` : `${option.daysLeft} 天`}
                        </span>
                      </TableCell>
                      <TableCell className="num text-right">{option.right === 'P' ? money(option.collateral) : '—'}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="xs" onClick={() => onOpenHolding(option.accountId, option.campaignId)}>打开战役</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <p className="footnote text-xs leading-relaxed text-muted-foreground">实际成本 = 纯股票成本扣减已落袋净权利金（含分红）；持仓盈亏 =（参考价 − 实际成本）× 股数，不含未平仓期权。合计只统计有参考价的持仓；已归档账户不参与统计。</p>
      </CardPanel>
    </Card>
  );
}
