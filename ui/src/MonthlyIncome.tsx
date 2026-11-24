import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { TrendingUpIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NativeSelect } from '@/components/native-select';
import { downloadCsv, money } from './lib';
import { GlossaryTerm } from './glossary';
import type { AccountReport, MonthlyIncome } from './types';

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const INK = '#18181b';
const INK_2 = '#52525b';
const INK_3 = '#71717a';
const LINE = 'rgba(24, 24, 27, .18)';
const GRID = 'rgba(24, 24, 27, .07)';
const FONT = 'Inter, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif';

export function MonthlyIncomeReport({ report, accounts, scope = 'account' }: {
  report: MonthlyIncome | null;
  accounts?: AccountReport[];
  scope?: 'account' | 'all';
}) {
  const element = useRef<HTMLDivElement>(null);
  const months = report?.months ?? [];
  const years = useMemo(() => [...new Set(months.map(month => month.month.slice(0, 4)))].sort().reverse(), [months]);
  const [year, setYear] = useState('all');
  useEffect(() => { if (year !== 'all' && !years.includes(year)) setYear('all'); }, [years, year]);

  const rows = useMemo(() => months.filter(month => year === 'all' || month.month.startsWith(year)), [months, year]);
  const chartRows = useMemo(() => {
    let running = 0;
    return rows.map(month => {
      running += month.total;
      return { month: month.month, total: month.total, cumulative: running };
    });
  }, [rows]);
  const totals = useMemo(() => rows.reduce((sum, month) => ({
    premium: sum.premium + month.premium,
    dividends: sum.dividends + month.dividends,
    fees: sum.fees + month.fees,
    adjustments: sum.adjustments + month.adjustments,
    total: sum.total + month.total,
    closedEntries: sum.closedEntries + month.closedEntries,
  }), { premium: 0, dividends: 0, fees: 0, adjustments: 0, total: 0, closedEntries: 0 }), [rows]);

  const accountRows = useMemo(() => {
    if (!accounts?.length) return [];
    return accounts
      .map(account => {
        const months = account.monthly.months.filter(month => year === 'all' || month.month.startsWith(year));
        return months.reduce((sum, month) => ({
          accountId: account.accountId,
          accountName: account.accountName,
          premium: sum.premium + month.premium,
          dividends: sum.dividends + month.dividends,
          fees: sum.fees + month.fees,
          adjustments: sum.adjustments + month.adjustments,
          total: sum.total + month.total,
          closedEntries: sum.closedEntries + month.closedEntries,
        }), {
          accountId: account.accountId,
          accountName: account.accountName,
          premium: 0, dividends: 0, fees: 0, adjustments: 0, total: 0, closedEntries: 0,
        });
      })
      .filter(row => row.premium !== 0 || row.dividends !== 0 || row.fees !== 0 || row.adjustments !== 0 || row.closedEntries > 0);
  }, [accounts, year]);

  useEffect(() => {
    if (!element.current || !chartRows.length) return;
    const chart = echarts.init(element.current);
    chart.setOption({
      backgroundColor: 'transparent',
      textStyle: { color: INK_2, fontFamily: FONT, fontSize: 12 },
      grid: { left: 16, right: 16, top: 44, bottom: 16, containLabel: true },
      legend: { top: 4, itemWidth: 14, itemHeight: 8, itemGap: 20, textStyle: { color: INK_2, fontSize: 12 } },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#ffffff',
        borderColor: LINE,
        borderWidth: 1,
        textStyle: { color: INK, fontSize: 12 },
        extraCssText: 'box-shadow: 0 8px 24px rgba(24,24,27,.10); border-radius: 8px;',
        formatter: (parameter: unknown) => {
          const items = parameter as { axisValue?: string; seriesName: string; value: number }[];
          if (!items.length) return '';
          return [`<strong>${items[0].axisValue}</strong>`, ...items.map(item => `${item.seriesName}：${money(item.value)}`)].join('<br/>');
        },
      },
      xAxis: {
        type: 'category',
        data: chartRows.map(row => row.month),
        axisLine: { lineStyle: { color: LINE } },
        axisLabel: { color: INK_3, fontSize: 11, formatter: (value: string) => value.slice(2) },
        axisTick: { show: false },
      },
      yAxis: [
        { type: 'value', axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: INK_3, fontSize: 11, formatter: (value: number) => `$${value.toLocaleString()}` }, splitLine: { lineStyle: { color: GRID } } },
        { type: 'value', show: false },
      ],
      series: [
        { name: '月度合计', type: 'bar', barMaxWidth: 28, itemStyle: { color: '#e4e4e7', borderRadius: [3, 3, 0, 0] }, emphasis: { itemStyle: { color: '#d4d4d8' } }, data: chartRows.map(row => Number(row.total.toFixed(2))) },
        { name: '区间累计', type: 'line', yAxisIndex: 1, symbol: 'circle', symbolSize: 5, showSymbol: false, lineStyle: { color: INK, width: 2 }, itemStyle: { color: INK, borderColor: '#ffffff', borderWidth: 2 }, data: chartRows.map(row => Number(row.cumulative.toFixed(2))) },
      ],
    });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(element.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [chartRows]);

  function exportRows() {
    downloadCsv(`wheel-income-${year === 'all' ? 'all' : year}.csv`, [
      ['月份', '净收租', '分红', '费用（含账户级）', '调整 / 利息', '合计', '区间累计', '了结合约'],
      ...[...chartRows].reverse().map(row => {
        const month = rows.find(item => item.month === row.month)!;
        return [row.month, month.premium, month.dividends, month.fees, month.adjustments, month.total, row.cumulative, month.closedEntries];
      }),
      ['合计', totals.premium, totals.dividends, totals.fees, totals.adjustments, totals.total, '', totals.closedEntries],
    ]);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><TrendingUpIcon className="size-4 text-muted-foreground" />收租月报</CardTitle>
        <CardDescription>已落袋口径 · 美东交易日按月</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-4">
        <p className="report-basis rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          口径：仅已实现 · 期权净收租按平仓日 · 分红、费用与调整按事件日 · 入金 / 出金不计入收益
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            年份
            <NativeSelect aria-label="选择年份" className="w-32" value={year} onChange={event => setYear(event.target.value)}>
              <option value="all">全部年份</option>
              {years.map(item => <option key={item} value={item}>{item}</option>)}
            </NativeSelect>
          </label>
          <Button variant="outline" size="sm" onClick={exportRows} disabled={!rows.length}>导出 CSV</Button>
        </div>
        {scope === 'all' && accounts && (
          <div className="account-income-breakdown space-y-2">
            <h3 className="font-heading text-sm font-semibold">按账户列示</h3>
            {accountRows.length ? (
              <div className="overflow-hidden rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>账户</TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="netPremium" /></TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="dividends" /></TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="fees">费用（含账户级）</GlossaryTerm></TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="adjustments" /></TableHead>
                      <TableHead className="text-right">合计</TableHead>
                      <TableHead className="text-right">了结合约</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accountRows.map(row => (
                      <TableRow key={row.accountId}>
                        <TableCell className="font-medium">{row.accountName}</TableCell>
                        <TableCell className="num text-right">{money(row.premium)}</TableCell>
                        <TableCell className="num text-right">{money(row.dividends)}</TableCell>
                        <TableCell className="num text-right">{money(row.fees)}</TableCell>
                        <TableCell className="num text-right">{money(row.adjustments)}</TableCell>
                        <TableCell className={`num text-right ${row.total < 0 ? 'negative text-destructive-foreground' : 'positive text-success-foreground'}`}>{money(row.total)}</TableCell>
                        <TableCell className="num text-right">{row.closedEntries}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell>合计</TableCell>
                      <TableCell className="num text-right">{money(totals.premium)}</TableCell>
                      <TableCell className="num text-right">{money(totals.dividends)}</TableCell>
                      <TableCell className="num text-right">{money(totals.fees)}</TableCell>
                      <TableCell className="num text-right">{money(totals.adjustments)}</TableCell>
                      <TableCell className="num text-right">{money(totals.total)}</TableCell>
                      <TableCell className="num text-right">{totals.closedEntries}</TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">所选年份没有账户收益。</p>
            )}
          </div>
        )}
        {!months.length ? (
          <p className="text-sm text-muted-foreground">了结第一笔卖出开仓后，这里会按月份累计净收租、分红与现金调整。</p>
        ) : (
          <>
            <div className="income-summary grid gap-4 rounded-xl border bg-muted/40 p-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="grid gap-0.5"><span className="text-xs text-muted-foreground"><GlossaryTerm id="realizedTotal" /></span><strong className={`num text-xl font-semibold ${totals.total < 0 ? 'negative text-destructive-foreground' : ''}`}>{money(totals.total)}</strong><small className="text-xs text-muted-foreground">{rows.length} 个月 · 净收租减费用加调整</small></div>
              <div className="grid gap-0.5"><span className="text-xs text-muted-foreground"><GlossaryTerm id="netPremium" /></span><strong className="num text-xl font-semibold">{money(totals.premium)}</strong><small className="text-xs text-muted-foreground">已扣开仓与平仓费用</small></div>
              <div className="grid gap-0.5"><span className="text-xs text-muted-foreground"><GlossaryTerm id="dividends" /></span><strong className="num text-xl font-semibold">{money(totals.dividends)}</strong><small className="text-xs text-muted-foreground">按派发日计入</small></div>
              <div className="grid gap-0.5"><span className="text-xs text-muted-foreground">了结合约</span><strong className="num text-xl font-semibold">{totals.closedEntries}<em className="text-xs font-normal not-italic text-muted-foreground"> 笔</em></strong><small className="text-xs text-muted-foreground">未平仓权利金不计入</small></div>
            </div>
            <div ref={element} className="income-chart chart-surface" role="img" aria-label="收租月报图：柱形为月度合计，折线为所选区间累计" />
            <div className="overflow-hidden rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>月份</TableHead>
                    <TableHead className="text-right"><GlossaryTerm id="netPremium" /></TableHead>
                    <TableHead className="text-right"><GlossaryTerm id="dividends" /></TableHead>
                    <TableHead className="text-right"><GlossaryTerm id="fees">费用（含账户级）</GlossaryTerm></TableHead>
                    <TableHead className="text-right"><GlossaryTerm id="adjustments" /></TableHead>
                    <TableHead className="text-right">合计</TableHead>
                    <TableHead className="text-right">区间累计</TableHead>
                    <TableHead className="text-right">了结合约</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...chartRows].reverse().map(row => {
                    const month = rows.find(item => item.month === row.month)!;
                    return (
                      <TableRow key={row.month}>
                        <TableCell className="num">{row.month}</TableCell>
                        <TableCell className="num text-right">{money(month.premium)}</TableCell>
                        <TableCell className="num text-right">{money(month.dividends)}</TableCell>
                        <TableCell className="num text-right">{money(month.fees)}</TableCell>
                        <TableCell className="num text-right">{money(month.adjustments)}</TableCell>
                        <TableCell className={`num text-right ${month.total < 0 ? 'negative text-destructive-foreground' : 'positive text-success-foreground'}`}>{money(month.total)}</TableCell>
                        <TableCell className="num text-right">{money(row.cumulative)}</TableCell>
                        <TableCell className="num text-right">{month.closedEntries}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell>合计</TableCell>
                    <TableCell className="num text-right">{money(totals.premium)}</TableCell>
                    <TableCell className="num text-right">{money(totals.dividends)}</TableCell>
                    <TableCell className="num text-right">{money(totals.fees)}</TableCell>
                    <TableCell className="num text-right">{money(totals.adjustments)}</TableCell>
                    <TableCell className="num text-right">{money(totals.total)}</TableCell>
                    <TableCell />
                    <TableCell className="num text-right">{totals.closedEntries}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          </>
        )}
        <p className="footnote text-xs leading-relaxed text-muted-foreground">净收租只统计已了结的期权行，已扣开仓与平仓费用；未平仓权利金与股票浮盈亏不计入。分红按派发日、费用与现金调整按事件日记账，分红已扣预扣税。账户级费用与利息不计入战役，只影响账户现金；“调整 / 利息”含现金调整、利息收入与融资利息。累计为所选年份区间内的累计。入金 / 出金是账户资金划转，不属于收益，不计入本表。</p>
      </CardPanel>
    </Card>
  );
}
