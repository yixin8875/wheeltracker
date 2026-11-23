import { useMemo, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { Position } from './types';
import { money } from './lib';

const DAY = 86_400_000;
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function utc(value: string) {
  return Date.parse(`${value}T00:00:00Z`);
}
function iso(value: number) {
  return new Date(value).toISOString().slice(0, 10);
}
function isoParts(value: string) {
  const [year, month] = value.split('-').map(Number);
  return { year, month: month - 1 };
}
function monthGrid(year: number, month: number) {
  const first = Date.UTC(year, month, 1);
  const weekday = (new Date(first).getUTCDay() + 6) % 7;
  const start = first - weekday * DAY;
  return Array.from({ length: 42 }, (_, index) => start + index * DAY);
}
function shiftMonth(year: number, month: number, delta: number) {
  const date = new Date(Date.UTC(year, month + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
}
function monthTitle(year: number, month: number) {
  return `${year} 年 ${month + 1} 月`;
}

export function ExpiryCalendar({ asOf, positions, onOpenCampaign }: {
  asOf: string; positions: Position[]; onOpenCampaign: (id: string) => void;
}) {
  const initial = isoParts(asOf);
  const [cursor, setCursor] = useState(initial);
  const [selected, setSelected] = useState(asOf);
  const today = utc(asOf);
  const cells = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);
  const byDate = useMemo(() => {
    const grouped = new Map<string, Position[]>();
    for (const position of positions) {
      const list = grouped.get(position.expiry) ?? [];
      list.push(position);
      grouped.set(position.expiry, list);
    }
    for (const list of grouped.values()) list.sort((left, right) => left.contract.localeCompare(right.contract));
    return grouped;
  }, [positions]);
  const selectedPositions = byDate.get(selected) ?? [];
  const upcoming = positions
    .filter(position => utc(position.expiry) >= today && utc(position.expiry) <= today + 30 * DAY)
    .sort((left, right) => left.expiry.localeCompare(right.expiry) || left.contract.localeCompare(right.contract));
  const total = positions.length;

  return (
    <div className="calendar-page grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">到期日历</CardTitle>
          <CardDescription>{total} 个未平仓合约 · 日期按美东交易日</CardDescription>
        </CardHeader>
        <CardPanel className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon-sm" aria-label="上一个月" onClick={() => setCursor(shiftMonth(cursor.year, cursor.month, -1))}><ChevronLeftIcon /></Button>
              <strong className="calendar-month num min-w-32 text-center text-sm font-medium">{monthTitle(cursor.year, cursor.month)}</strong>
              <Button variant="outline" size="icon-sm" aria-label="下一个月" onClick={() => setCursor(shiftMonth(cursor.year, cursor.month, 1))}><ChevronRightIcon /></Button>
            </div>
            <Button variant="ghost" size="sm" onClick={() => { setCursor(initial); setSelected(asOf); }}>回到今天</Button>
          </div>
          <div className="calendar-legend flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><i className="legend-dot today size-2 rounded-full bg-primary" />今天</span>
            <span className="flex items-center gap-1.5"><i className="legend-dot selected size-2 rounded-full bg-foreground" />已选择</span>
            <span className="flex items-center gap-1.5"><i className="legend-dot overdue size-2 rounded-full bg-destructive" />已过期</span>
            <span className="flex items-center gap-1.5"><i className="legend-dot contracts size-2 rounded-full bg-info" />有到期</span>
          </div>
          <div className="calendar-grid grid grid-cols-7 gap-px overflow-hidden rounded-xl border bg-border" role="grid" aria-label={`${monthTitle(cursor.year, cursor.month)}到期日历`}>
            {WEEKDAYS.map(day => <div key={day} className="calendar-weekday bg-muted/60 px-1 py-1.5 text-center text-xs font-medium text-muted-foreground" role="columnheader">周{day}</div>)}
            {cells.map(value => {
              const date = iso(value);
              const list = byDate.get(date) ?? [];
              const outside = new Date(value).getUTCMonth() !== cursor.month;
              const overdue = list.length > 0 && value < today;
              return (
                <button
                  key={date}
                  type="button"
                  role="gridcell"
                  aria-pressed={date === selected}
                  aria-label={`${date}${list.length ? `，${list.length} 个到期合约` : '，无到期合约'}`}
                  onClick={() => { setSelected(date); if (outside) setCursor(isoParts(date)); }}
                  className={cn(
                    'calendar-cell flex min-h-20 flex-col items-stretch gap-1 bg-card p-1.5 text-left align-top transition-colors hover:bg-accent/50 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring',
                    outside && 'outside text-muted-foreground/50',
                    date === asOf && 'today ring-1 ring-inset ring-primary/40',
                    date === selected && 'selected bg-accent',
                    overdue && 'overdue',
                  )}
                >
                  <span className="calendar-day num text-xs font-medium">{Number(date.slice(8))}</span>
                  {list.slice(0, 2).map(position => (
                    <span key={position.contract} className="calendar-chip truncate rounded bg-info/12 px-1 py-0.5 text-[11px] leading-tight text-info-foreground">
                      {position.symbol} {position.strike}{position.right} ×{position.openQty}
                    </span>
                  ))}
                  {list.length > 2 && <span className="calendar-more text-[11px] text-muted-foreground">+{list.length - 2}</span>}
                </button>
              );
            })}
          </div>
        </CardPanel>
      </Card>

      <Card render={<section />}>
        <CardHeader>
          <CardTitle className="text-base">{selected} 到期合约</CardTitle>
          <CardDescription>{selectedPositions.length ? `${selectedPositions.length} 个合约` : '无到期合约'}</CardDescription>
        </CardHeader>
        <CardPanel>
          {!selectedPositions.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>这一天没有未平仓期权到期</EmptyTitle>
                <EmptyDescription>选择带蓝色标记的日期查看那一天到期的合约。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-hidden rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>合约</TableHead>
                    <TableHead>方向</TableHead>
                    <TableHead className="text-right">行权价</TableHead>
                    <TableHead className="text-right">手数</TableHead>
                    <TableHead className="text-right">每股净权利金</TableHead>
                    <TableHead>剩余天数</TableHead>
                    <TableHead className="text-right">战役</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedPositions.map(position => (
                    <TableRow key={position.contract}>
                      <TableCell className="font-medium">{position.contract}</TableCell>
                      <TableCell>{position.right === 'P' ? 'Put' : 'Call'}</TableCell>
                      <TableCell className="num text-right">{money(position.strike)}</TableCell>
                      <TableCell className="num text-right">{position.openQty}</TableCell>
                      <TableCell className="num text-right">{money(position.avgCredit)}</TableCell>
                      <TableCell>
                        <span className={position.daysLeft < 0 ? 'text-destructive-foreground' : position.daysLeft <= 7 ? 'warning-text text-warning-foreground' : ''}>
                          {position.daysLeft < 0 ? `已过期 ${-position.daysLeft} 天` : `${position.daysLeft} 天`}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="link" size="xs" onClick={() => onOpenCampaign(position.campaignId)}>查看战役</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardPanel>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">未来 30 天</CardTitle>
          <CardDescription>从 {asOf} 起算</CardDescription>
        </CardHeader>
        <CardPanel>
          {!upcoming.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>未来 30 天没有到期合约</EmptyTitle>
                <EmptyDescription>新的卖出合约到期日会显示在这里。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="upcoming-strip flex flex-wrap gap-2">
              {upcoming.map(position => (
                <button
                  key={position.contract}
                  type="button"
                  className={cn(
                    'upcoming-chip grid gap-0.5 rounded-lg border bg-card px-3 py-2 text-left text-xs transition-colors hover:bg-accent/50',
                    position.daysLeft < 0 && 'overdue border-destructive/40',
                    position.daysLeft >= 0 && position.daysLeft <= 7 && 'critical border-warning/50',
                  )}
                  onClick={() => { setSelected(position.expiry); setCursor(isoParts(position.expiry)); }}
                >
                  <strong className="num text-sm font-medium">{position.expiry}</strong>
                  <span>{position.contract}</span>
                  <small className="text-muted-foreground">{position.daysLeft} 天后 · {position.openQty} 手</small>
                </button>
              ))}
            </div>
          )}
        </CardPanel>
      </Card>
    </div>
  );
}
