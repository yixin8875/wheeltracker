import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { ChartColumn } from 'lucide-react';
import { downloadCsv, money } from './lib';
import { exportAnnualReport } from './export';
import type { AnnualReport, AnnualYear } from './types';

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export function AnnualReportPage({ report }: { report: AnnualReport | null }) {
  const years = useMemo(() => [...(report?.availableYears ?? [])].sort((left, right) => right - left), [report]);
  const [year, setYear] = useState<number | null>(null);
  useEffect(() => {
    if (years.length && (year === null || !years.includes(year))) setYear(years[0]);
  }, [years, year]);
  const current: AnnualYear | null = report?.years.find(item => item.year === year) ?? null;
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!element.current || !current?.months.length) return;
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
        data: current.months.map(month => month.month),
        axisLabel: { color: '#626873', formatter: (value: string) => value.slice(2) },
        axisTick: { show: false },
      },
      yAxis: [
        { type: 'value', name: '月度', axisLabel: { color: '#626873', formatter: (value: number) => `$${value}` }, splitLine: { lineStyle: { color: '#edf0f3' } } },
        { type: 'value', name: '累计', axisLabel: { color: '#626873', formatter: (value: number) => `$${value}` }, splitLine: { show: false } },
      ],
      series: [
        { name: '月度合计', type: 'bar', barMaxWidth: 36, itemStyle: { color: '#2a78d6', borderRadius: [3, 3, 0, 0] }, data: current.months.map(month => Number(month.total.toFixed(2))) },
        { name: '年度累计', type: 'line', yAxisIndex: 1, symbol: 'circle', symbolSize: 6, lineStyle: { color: '#eb6834' }, itemStyle: { color: '#eb6834' }, data: current.months.map(month => Number(month.cumulative.toFixed(2))) },
      ],
    });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(element.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [current]);

  function exportRows() {
    if (!current) return;
    downloadCsv(`wheel-annual-${current.year}.csv`, [
      ['年度报表', current.year, '已实现口径'],
      ['月份', '净收租', '股票已实现盈亏', '分红', '独立费用', '现金调整', '合计', '年度累计', '了结合约', '股票事件'],
      ...[...current.months].reverse().map(month => [
        month.month, month.premium, month.sharePnl, month.dividends, month.fees,
        month.adjustments, month.total, month.cumulative, month.closedEntries, month.shareEvents,
      ]),
      ['年度合计', current.total.premium, current.total.sharePnl, current.total.dividends, current.total.fees,
        current.total.adjustments, current.total.total, '', current.total.closedEntries, current.total.shareEvents],
      ['标的归因'],
      ['标的', '净收租', '股票已实现盈亏', '分红', '独立费用', '现金调整', '合计'],
      ...current.symbols.map(symbol => [symbol.symbol, symbol.premium, symbol.sharePnl, symbol.dividends, symbol.fees, symbol.adjustments, symbol.total]),
    ]);
  }

  return <section className="panel">
    <div className="section-heading">
      <div><h2><ChartColumn size={18}/> 年度报表</h2><span className="muted">已实现口径 · 美东交易日按年</span></div>
      <div className="toolbar">
        <label className="inline-select">年份<select aria-label="选择年份" value={year ?? ''} disabled={!years.length} onChange={event => setYear(Number(event.target.value))}>{years.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
        <button onClick={exportRows} disabled={!current}>导出 CSV</button>
        <button onClick={() => current && exportAnnualReport(current)} disabled={!current}>导出 Excel</button>
      </div>
    </div>
    {!report?.years.length ? <p className="empty">有了结的期权、股票卖出、分红或拆股零股补偿后，这里会按年度汇总已实现收益。</p> : current && <>
      <div className="summary-strip annual-summary">
        <div><span>年度合计</span><strong className={current.total.total < 0 ? 'negative' : ''}>{money(current.total.total)}</strong><small>{current.months.length} 个月 · 已实现口径</small></div>
        <div><span>净收租</span><strong>{money(current.total.premium)}</strong><small>按平仓日计入</small></div>
        <div><span>股票已实现盈亏</span><strong>{money(current.total.sharePnl)}</strong><small>卖出、Call 指派、零股补偿</small></div>
        <div><span>分红</span><strong>{money(current.total.dividends)}</strong><small>按派发日计入</small></div>
        <div><span>独立费用</span><strong>{money(current.total.fees)}</strong><small>已从合计扣除</small></div>
        <div><span>现金调整</span><strong>{money(current.total.adjustments)}</strong><small>计入合计</small></div>
      </div>
      <div ref={element} className="income-chart" role="img" aria-label="年度已实现收益图：柱形为月度合计，折线为年度累计"/>
      <h3>月度明细</h3>
      <div className="table-wrap monthly-breakdown"><table>
        <thead><tr><th>月份</th><th>净收租</th><th>股票已实现盈亏</th><th>分红</th><th>独立费用</th><th>现金调整</th><th>合计</th><th>年度累计</th><th>了结合约</th><th>股票事件</th></tr></thead>
        <tbody>{[...current.months].reverse().map(month => <tr key={month.month}>
          <td>{month.month}</td>
          <td>{money(month.premium)}</td>
          <td>{money(month.sharePnl)}</td>
          <td>{money(month.dividends)}</td>
          <td>{money(month.fees)}</td>
          <td>{money(month.adjustments)}</td>
          <td className={month.total < 0 ? 'negative' : 'positive'}>{money(month.total)}</td>
          <td>{money(month.cumulative)}</td>
          <td>{month.closedEntries}</td>
          <td>{month.shareEvents}</td>
        </tr>)}</tbody>
        <tfoot><tr><th>年度合计</th><th>{money(current.total.premium)}</th><th>{money(current.total.sharePnl)}</th><th>{money(current.total.dividends)}</th><th>{money(current.total.fees)}</th><th>{money(current.total.adjustments)}</th><th>{money(current.total.total)}</th><th></th><th>{current.total.closedEntries}</th><th>{current.total.shareEvents}</th></tr></tfoot>
      </table></div>
      <h3>按标的归因</h3>
      <div className="table-wrap symbol-breakdown"><table>
        <thead><tr><th>标的</th><th>净收租</th><th>股票已实现盈亏</th><th>分红</th><th>独立费用</th><th>现金调整</th><th>合计</th></tr></thead>
        <tbody>{current.symbols.map(symbol => <tr key={symbol.symbol}>
          <td>{symbol.symbol}</td>
          <td>{money(symbol.premium)}</td>
          <td>{money(symbol.sharePnl)}</td>
          <td>{money(symbol.dividends)}</td>
          <td>{money(symbol.fees)}</td>
          <td>{money(symbol.adjustments)}</td>
          <td className={symbol.total < 0 ? 'negative' : 'positive'}>{money(symbol.total)}</td>
        </tr>)}</tbody>
      </table></div>
    </>}
    <p className="footnote">已实现口径：期权净收租按平仓日计入，股票已实现盈亏按卖出 / Call 指派 / 拆股零股补偿日计入，分红、费用与现金调整按事件日计入。不含未平仓权利金与股票浮盈亏；入金 / 出金是账户资金划转，不属于收益，不计入本表；本表也不是税务申报表。</p>
  </section>;
}
