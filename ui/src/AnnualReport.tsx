import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { ChartColumnIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NativeSelect } from '@/components/native-select';
import { downloadCsv, money } from './lib';
import { exportAnnualReport } from './export';
import { GlossaryTerm } from './glossary';
import type { AccountReport, AnnualReport, AnnualYear } from './types';

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const INK = '#18181b';
const INK_2 = '#52525b';
const INK_3 = '#71717a';
const LINE = 'rgba(24, 24, 27, .18)';
const GRID = 'rgba(24, 24, 27, .07)';
const FONT = 'Inter, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif';

export function AnnualReportPage({ report, accounts, scope = 'account' }: {
  report: AnnualReport | null;
  accounts?: AccountReport[];
  scope?: 'account' | 'all';
}) {
  const years = useMemo(() => [...(report?.availableYears ?? [])].sort((left, right) => right - left), [report]);
  const [year, setYear] = useState<number | null>(null);
  useEffect(() => {
    if (years.length && (year === null || !years.includes(year))) setYear(years[0]);
  }, [years, year]);
  const current: AnnualYear | null = report?.years.find(item => item.year === year) ?? null;
  const accountRows = useMemo(() => {
    if (!current || !accounts?.length) return [];
    return accounts.flatMap(account => {
      const yearReport = account.annual.years.find(item => item.year === current.year);
      return yearReport
        ? [{ accountId: account.accountId, accountName: account.accountName, total: yearReport.total }]
        : [];
    });
  }, [accounts, current]);
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!element.current || !current?.months.length) return;
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
        data: current.months.map(month => month.month),
        axisLine: { lineStyle: { color: LINE } },
        axisLabel: { color: INK_3, fontSize: 11, formatter: (value: string) => value.slice(2) },
        axisTick: { show: false },
      },
      yAxis: [
        { type: 'value', axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: INK_3, fontSize: 11, formatter: (value: number) => `$${value.toLocaleString()}` }, splitLine: { lineStyle: { color: GRID } } },
        { type: 'value', show: false },
      ],
      series: [
        { name: '月度合计', type: 'bar', barMaxWidth: 28, itemStyle: { color: '#e4e4e7', borderRadius: [3, 3, 0, 0] }, emphasis: { itemStyle: { color: '#d4d4d8' } }, data: current.months.map(month => Number(month.total.toFixed(2))) },
        { name: '年度累计', type: 'line', yAxisIndex: 1, symbol: 'circle', symbolSize: 5, showSymbol: false, lineStyle: { color: INK, width: 2 }, itemStyle: { color: INK, borderColor: '#ffffff', borderWidth: 2 }, data: current.months.map(month => Number(month.cumulative.toFixed(2))) },
      ],
    });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(element.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [current]);

  function exportRows() {
    if (!current) return;
    downloadCsv(`wheel-annual-${current.year}.csv`, [
      ['年度报表', current.year, '已实现口径'],
      ['月份', '净收租', '股票已实现盈亏', '分红', '费用（含账户级）', '调整 / 利息', '合计', '年度累计', '了结合约', '股票事件'],
      ...[...current.months].reverse().map(month => [
        month.month, month.premium, month.sharePnl, month.dividends, month.fees,
        month.adjustments, month.total, month.cumulative, month.closedEntries, month.shareEvents,
      ]),
      ['年度合计', current.total.premium, current.total.sharePnl, current.total.dividends, current.total.fees,
        current.total.adjustments, current.total.total, '', current.total.closedEntries, current.total.shareEvents],
      ...(scope === 'all' && accountRows.length ? [
        ['按账户'],
        ['账户', '净收租', '股票已实现盈亏', '分红', '费用（含账户级）', '调整 / 利息', '合计'],
        ...accountRows.map(row => [row.accountName, row.total.premium, row.total.sharePnl, row.total.dividends,
          row.total.fees, row.total.adjustments, row.total.total]),
        ['账户合计', current.total.premium, current.total.sharePnl, current.total.dividends,
          current.total.fees, current.total.adjustments, current.total.total],
      ] : []),
      ['标的归因'],
      ['标的', '净收租', '股票已实现盈亏', '分红', '费用（含账户级）', '调整 / 利息', '合计'],
      ...current.symbols.map(symbol => [symbol.symbol, symbol.premium, symbol.sharePnl, symbol.dividends, symbol.fees, symbol.adjustments, symbol.total]),
    ]);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><ChartColumnIcon className="size-4 text-muted-foreground" />年度报表</CardTitle>
        <CardDescription>已实现口径 · 美东交易日按年</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-4">
        <p className="report-basis rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          口径：仅已实现 · 净收租按平仓日 · 股票盈亏按卖出 / 指派日 · 分红、费用与调整按事件日 · 入金 / 出金不计入收益
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            年份
            <NativeSelect aria-label="选择年份" className="w-28" value={year ?? ''} disabled={!years.length} onChange={event => setYear(Number(event.target.value))}>
              {years.map(item => <option key={item} value={item}>{item}</option>)}
            </NativeSelect>
          </label>
          <Button variant="outline" size="sm" onClick={exportRows} disabled={!current}>导出 CSV</Button>
          <Button variant="outline" size="sm" onClick={() => current && exportAnnualReport(current)} disabled={!current}>导出 Excel</Button>
        </div>
        {scope === 'all' && accounts && current && (
          <div className="account-annual-breakdown space-y-2">
            <h3 className="font-heading text-sm font-semibold">按账户列示</h3>
            {accountRows.length ? (
              <div className="overflow-hidden rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>账户</TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="netPremium" /></TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="sharePnl" /></TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="dividends" /></TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="fees">费用（含账户级）</GlossaryTerm></TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="adjustments" /></TableHead>
                      <TableHead className="text-right">合计</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accountRows.map(row => (
                      <TableRow key={row.accountId}>
                        <TableCell className="font-medium">{row.accountName}</TableCell>
                        <TableCell className="num text-right">{money(row.total.premium)}</TableCell>
                        <TableCell className="num text-right">{money(row.total.sharePnl)}</TableCell>
                        <TableCell className="num text-right">{money(row.total.dividends)}</TableCell>
                        <TableCell className="num text-right">{money(row.total.fees)}</TableCell>
                        <TableCell className="num text-right">{money(row.total.adjustments)}</TableCell>
                        <TableCell className={`num text-right ${row.total.total < 0 ? 'negative text-destructive-foreground' : 'positive text-success-foreground'}`}>{money(row.total.total)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell>合计</TableCell>
                      <TableCell className="num text-right">{money(current.total.premium)}</TableCell>
                      <TableCell className="num text-right">{money(current.total.sharePnl)}</TableCell>
                      <TableCell className="num text-right">{money(current.total.dividends)}</TableCell>
                      <TableCell className="num text-right">{money(current.total.fees)}</TableCell>
                      <TableCell className="num text-right">{money(current.total.adjustments)}</TableCell>
                      <TableCell className="num text-right">{money(current.total.total)}</TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">所选年份没有账户收益。</p>
            )}
          </div>
        )}
        {!report?.years.length ? (
          <p className="text-sm text-muted-foreground">有了结的期权、股票卖出、分红或拆股零股补偿后，这里会按年度汇总已实现收益。</p>
        ) : current && (
          <>
            <div className="annual-summary grid gap-4 rounded-xl border bg-muted/40 p-4 sm:grid-cols-3 xl:grid-cols-6">
              <div className="grid gap-0.5"><span className="text-xs text-muted-foreground"><GlossaryTerm id="annualTotal" /></span><strong className={`num text-xl font-semibold ${current.total.total < 0 ? 'negative text-destructive-foreground' : ''}`}>{money(current.total.total)}</strong><small className="text-xs text-muted-foreground">{current.months.length} 个月 · 已实现口径</small></div>
              <div className="grid gap-0.5"><span className="text-xs text-muted-foreground"><GlossaryTerm id="netPremium" /></span><strong className="num text-xl font-semibold">{money(current.total.premium)}</strong><small className="text-xs text-muted-foreground">按平仓日计入</small></div>
              <div className="grid gap-0.5"><span className="text-xs text-muted-foreground"><GlossaryTerm id="sharePnl" /></span><strong className="num text-xl font-semibold">{money(current.total.sharePnl)}</strong><small className="text-xs text-muted-foreground">卖出、Call 指派、零股补偿</small></div>
              <div className="grid gap-0.5"><span className="text-xs text-muted-foreground"><GlossaryTerm id="dividends" /></span><strong className="num text-xl font-semibold">{money(current.total.dividends)}</strong><small className="text-xs text-muted-foreground">按派发日计入</small></div>
              <div className="grid gap-0.5"><span className="text-xs text-muted-foreground"><GlossaryTerm id="fees">费用（含账户级）</GlossaryTerm></span><strong className="num text-xl font-semibold">{money(current.total.fees)}</strong><small className="text-xs text-muted-foreground">已从合计扣除</small></div>
              <div className="grid gap-0.5"><span className="text-xs text-muted-foreground"><GlossaryTerm id="adjustments" /></span><strong className="num text-xl font-semibold">{money(current.total.adjustments)}</strong><small className="text-xs text-muted-foreground">计入合计</small></div>
            </div>
            <div ref={element} className="income-chart chart-surface" role="img" aria-label="年度已实现收益图：柱形为月度合计，折线为年度累计" />
            <div className="space-y-2">
              <h3 className="font-heading text-sm font-semibold">月度明细</h3>
              <div className="monthly-breakdown overflow-hidden rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>月份</TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="netPremium" /></TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="sharePnl" /></TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="dividends" /></TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="fees">费用（含账户级）</GlossaryTerm></TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="adjustments" /></TableHead>
                      <TableHead className="text-right">合计</TableHead>
                      <TableHead className="text-right">年度累计</TableHead>
                      <TableHead className="text-right">了结合约</TableHead>
                      <TableHead className="text-right">股票事件</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...current.months].reverse().map(month => (
                      <TableRow key={month.month}>
                        <TableCell className="num">{month.month}</TableCell>
                        <TableCell className="num text-right">{money(month.premium)}</TableCell>
                        <TableCell className="num text-right">{money(month.sharePnl)}</TableCell>
                        <TableCell className="num text-right">{money(month.dividends)}</TableCell>
                        <TableCell className="num text-right">{money(month.fees)}</TableCell>
                        <TableCell className="num text-right">{money(month.adjustments)}</TableCell>
                        <TableCell className={`num text-right ${month.total < 0 ? 'negative text-destructive-foreground' : 'positive text-success-foreground'}`}>{money(month.total)}</TableCell>
                        <TableCell className="num text-right">{money(month.cumulative)}</TableCell>
                        <TableCell className="num text-right">{month.closedEntries}</TableCell>
                        <TableCell className="num text-right">{month.shareEvents}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell>年度合计</TableCell>
                      <TableCell className="num text-right">{money(current.total.premium)}</TableCell>
                      <TableCell className="num text-right">{money(current.total.sharePnl)}</TableCell>
                      <TableCell className="num text-right">{money(current.total.dividends)}</TableCell>
                      <TableCell className="num text-right">{money(current.total.fees)}</TableCell>
                      <TableCell className="num text-right">{money(current.total.adjustments)}</TableCell>
                      <TableCell className="num text-right">{money(current.total.total)}</TableCell>
                      <TableCell />
                      <TableCell className="num text-right">{current.total.closedEntries}</TableCell>
                      <TableCell className="num text-right">{current.total.shareEvents}</TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            </div>
            <div className="space-y-2">
              <h3 className="font-heading text-sm font-semibold">按标的归因</h3>
              <div className="symbol-breakdown overflow-hidden rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>标的</TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="netPremium" /></TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="sharePnl" /></TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="dividends" /></TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="fees">费用（含账户级）</GlossaryTerm></TableHead>
                      <TableHead className="text-right"><GlossaryTerm id="adjustments" /></TableHead>
                      <TableHead className="text-right">合计</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {current.symbols.map(symbol => (
                      <TableRow key={symbol.symbol}>
                        <TableCell className="font-medium">{symbol.symbol}</TableCell>
                        <TableCell className="num text-right">{money(symbol.premium)}</TableCell>
                        <TableCell className="num text-right">{money(symbol.sharePnl)}</TableCell>
                        <TableCell className="num text-right">{money(symbol.dividends)}</TableCell>
                        <TableCell className="num text-right">{money(symbol.fees)}</TableCell>
                        <TableCell className="num text-right">{money(symbol.adjustments)}</TableCell>
                        <TableCell className={`num text-right ${symbol.total < 0 ? 'negative text-destructive-foreground' : 'positive text-success-foreground'}`}>{money(symbol.total)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </>
        )}
        <p className="footnote text-xs leading-relaxed text-muted-foreground">已实现口径：期权净收租按平仓日计入，股票已实现盈亏按卖出 / Call 指派 / 拆股零股补偿日计入，分红、费用与现金调整按事件日计入，分红已扣预扣税。账户级费用与利息不计入战役，只影响账户现金；“调整 / 利息”含现金调整、利息收入与融资利息。不含未平仓权利金与股票浮盈亏；入金 / 出金是账户资金划转，不属于收益，不计入本表；本表也不是税务申报表。</p>
      </CardPanel>
    </Card>
  );
}
