import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { TrendingUp } from 'lucide-react';
import { downloadCsv, money } from './lib';
import type { MonthlyIncome } from './types';

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export function MonthlyIncomeReport({ report }: { report: MonthlyIncome | null }) {
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

  useEffect(() => {
    if (!element.current || !chartRows.length) return;
    const chart = echarts.init(element.current);
    chart.setOption({
      backgroundColor: '#ffffff',
      textStyle: { color: '#626873', fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif' },
      grid: { left: 20, right: 24, top: 56, bottom: 24, containLabel: true },
      legend: { top: 8, textStyle: { color: '#626873' } },
      tooltip: {
        trigger: 'axis',
        formatter: (parameter: unknown) => {
          const items = parameter as { axisValue?: string; seriesName: string; value: number }[];
          if (!items.length) return '';
          return [`<strong>${items[0].axisValue}</strong>`, ...items.map(item => `${item.seriesName}：${money(item.value)}`)].join('<br/>');
        },
      },
      xAxis: {
        type: 'category',
        data: chartRows.map(row => row.month),
        axisLabel: { color: '#626873', formatter: (value: string) => value.slice(2) },
        axisTick: { show: false },
      },
      yAxis: [
        { type: 'value', name: '月度', axisLabel: { color: '#626873', formatter: (value: number) => `$${value}` }, splitLine: { lineStyle: { color: '#edf0f3' } } },
        { type: 'value', name: '累计', axisLabel: { color: '#626873', formatter: (value: number) => `$${value}` }, splitLine: { show: false } },
      ],
      series: [
        { name: '月度合计', type: 'bar', barMaxWidth: 36, itemStyle: { color: '#2a78d6', borderRadius: [3, 3, 0, 0] }, data: chartRows.map(row => Number(row.total.toFixed(2))) },
        { name: '区间累计', type: 'line', yAxisIndex: 1, symbol: 'circle', symbolSize: 6, lineStyle: { color: '#eb6834' }, itemStyle: { color: '#eb6834' }, data: chartRows.map(row => Number(row.cumulative.toFixed(2))) },
      ],
    });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(element.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [chartRows]);

  function exportRows() {
    downloadCsv(`wheel-income-${year === 'all' ? 'all' : year}.csv`, [
      ['月份', '净收租', '分红', '独立费用', '现金调整', '合计', '区间累计', '了结合约'],
      ...[...chartRows].reverse().map(row => {
        const month = rows.find(item => item.month === row.month)!;
        return [row.month, month.premium, month.dividends, month.fees, month.adjustments, month.total, row.cumulative, month.closedEntries];
      }),
      ['合计', totals.premium, totals.dividends, totals.fees, totals.adjustments, totals.total, '', totals.closedEntries],
    ]);
  }

  return <section className="panel">
    <div className="section-heading">
      <div><h2><TrendingUp size={18}/> 收租月报</h2><span className="muted">已落袋口径 · UTC 月份</span></div>
      <div className="toolbar">
        <label className="inline-select">年份<select aria-label="选择年份" value={year} onChange={event => setYear(event.target.value)}><option value="all">全部年份</option>{years.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
        <button onClick={exportRows} disabled={!rows.length}>导出 CSV</button>
      </div>
    </div>
    {!months.length ? <p className="empty">了结第一笔卖出开仓后，这里会按月份累计净收租、分红与现金调整。</p> : <>
      <div className="summary-strip income-summary">
        <div><span>区间合计</span><strong className={totals.total < 0 ? 'negative' : ''}>{money(totals.total)}</strong><small>{rows.length} 个月 · 净收租减费用加调整</small></div>
        <div><span>已落袋净收租</span><strong>{money(totals.premium)}</strong><small>已扣开仓与平仓费用</small></div>
        <div><span>分红</span><strong>{money(totals.dividends)}</strong><small>按派发日计入</small></div>
        <div><span>了结合约</span><strong>{totals.closedEntries}<em> 笔</em></strong><small>未平仓权利金不计入</small></div>
      </div>
      <div ref={element} className="income-chart" role="img" aria-label="收租月报图：柱形为月度合计，折线为所选区间累计"/>
      <div className="table-wrap"><table>
        <thead><tr><th>月份</th><th>净收租</th><th>分红</th><th>独立费用</th><th>现金调整</th><th>合计</th><th>区间累计</th><th>了结合约</th></tr></thead>
        <tbody>{[...chartRows].reverse().map(row => {
          const month = rows.find(item => item.month === row.month)!;
          return <tr key={row.month}>
            <td>{row.month}</td>
            <td>{money(month.premium)}</td>
            <td>{money(month.dividends)}</td>
            <td>{money(month.fees)}</td>
            <td>{money(month.adjustments)}</td>
            <td className={month.total < 0 ? 'negative' : 'positive'}>{money(month.total)}</td>
            <td>{money(row.cumulative)}</td>
            <td>{month.closedEntries}</td>
          </tr>;
        })}</tbody>
        <tfoot><tr><th>合计</th><th>{money(totals.premium)}</th><th>{money(totals.dividends)}</th><th>{money(totals.fees)}</th><th>{money(totals.adjustments)}</th><th>{money(totals.total)}</th><th></th><th>{totals.closedEntries}</th></tr></tfoot>
      </table></div>
    </>}
    <p className="footnote">净收租只统计已了结的期权行，已扣开仓与平仓费用；未平仓权利金与股票浮盈亏不计入。分红按派发日、费用与现金调整按事件日记账。累计为所选年份区间内的累计。</p>
  </section>;
}
