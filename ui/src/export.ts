import type { Campaign, Entry, EventRow, Position } from './types';
import { labels, today } from './lib';
import { downloadXlsx, type Sheet } from './xlsx';

export function ledgerSheet(entries: Entry[]): Sheet {
  return {
    name: '台账',
    rows: [
      ['开仓日期', '平仓日期', '标的', '合约', '方向', '手数', '状态', '毛权利金', '平仓成本', '费用', '净权利金', '占用资金', '持有天数', '年化收益率', '战役'],
      ...entries.map(entry => [
        entry.openedAt, entry.closedAt ?? '', entry.symbol, entry.contract, entry.right === 'P' ? 'Put' : 'Call',
        entry.qty, labels[entry.status] ?? entry.status, entry.premiumGross, entry.closeCost, entry.fees,
        entry.netPremium, entry.collateral, entry.daysHeld ?? '', entry.annualizedReturn ?? '', entry.campaignId,
      ]),
    ],
    columnWidths: [12, 12, 10, 26, 8, 8, 10, 14, 14, 10, 14, 14, 10, 12, 14],
    styles: ['text', 'text', 'text', 'text', 'text', 'number', 'text', 'money', 'money', 'money', 'money', 'money', 'number', 'percent', 'text'],
  };
}

export function eventsSheet(events: EventRow[]): Sheet {
  return {
    name: '交易记录',
    rows: [
      ['记录 ID', '日期', '类型', '标的', '数量', '每股价格', '费用', '金额', '到期日', '行权价', '看涨/看跌', '备注'],
      ...events.map(event => [
        event.id, event.date, labels[event.kind] ?? event.kind, event.symbol, event.qty, event.price, event.fees,
        event.amount, event.expiry ?? '', event.strike ?? '', event.right ?? '', event.note,
      ]),
    ],
    columnWidths: [24, 12, 14, 10, 8, 12, 10, 12, 12, 10, 10, 36],
    styles: ['text', 'text', 'text', 'text', 'number', 'money', 'money', 'money', 'text', 'money', 'text', 'text'],
  };
}

export function positionsSheet(positions: Position[]): Sheet {
  return {
    name: '持仓',
    rows: [
      ['标的', '合约', '方向', '行权价', '到期日', '剩余天数', '手数', '每股净权利金', '开仓日期', '战役'],
      ...positions.map(position => [
        position.symbol, position.contract, position.right === 'P' ? 'Put' : 'Call', position.strike, position.expiry,
        position.daysLeft, position.openQty, position.avgCredit, position.openedAt, position.campaignId,
      ]),
    ],
    columnWidths: [10, 26, 8, 10, 12, 10, 8, 14, 12, 14],
    styles: ['text', 'text', 'text', 'money', 'text', 'number', 'number', 'money', 'text', 'text'],
  };
}

export function campaignsSheet(campaigns: Campaign[]): Sheet {
  return {
    name: '战役',
    rows: [
      ['标的', '状态', '开始日期', '结束日期', '持股', '纯股票成本', '有效成本', '含未平仓成本', '已落袋权利金', '未平仓权利金', '分红', '现金调整', '已实现收益', '了结次数'],
      ...campaigns.map(campaign => [
        campaign.symbol, campaign.status === 'active' ? '进行中' : '已结束', campaign.startedAt, campaign.endedAt ?? '',
        campaign.shares, campaign.costA ?? '', campaign.costB ?? '', campaign.costC ?? '', campaign.premiumRealized,
        campaign.premiumOpen, campaign.dividends, campaign.adjustments, campaign.realizedPnl ?? '', campaign.cycles,
      ]),
    ],
    columnWidths: [10, 10, 12, 12, 8, 14, 14, 16, 16, 16, 12, 12, 16, 10],
    styles: ['text', 'text', 'text', 'text', 'number', 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'number'],
  };
}

export function exportWorkbook(data: { entries: Entry[]; events: EventRow[]; positions: Position[]; campaigns: Campaign[] }, name = `wheel-tracker-${today()}.xlsx`) {
  downloadXlsx(name, [ledgerSheet(data.entries), eventsSheet(data.events), positionsSheet(data.positions), campaignsSheet(data.campaigns)]);
}

export function exportLedger(entries: Entry[], name = `wheel-ledger-${today()}.xlsx`) {
  downloadXlsx(name, [ledgerSheet(entries)]);
}
