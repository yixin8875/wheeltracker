import type { ReactNode } from 'react';

/** One shared vocabulary for cost lines, income lines and report totals. */
export const GLOSSARY = {
  netPremium: {
    term: '净收租',
    definition: '已了结期权行的卖出权利金减去买入平仓成本，再扣开仓与平仓费用；未平仓权利金不计入。',
  },
  realizedTotal: {
    term: '区间合计',
    definition: '净收租 + 分红 − 费用 + 调整/利息。仅统计已实现项目；股票已实现盈亏只在年度报表中计入。',
  },
  sharePnl: {
    term: '股票已实现盈亏',
    definition: '卖出股票、Call 指派卖出、拆股零股补偿产生的已实现盈亏；不含持仓浮盈亏。',
  },
  dividends: {
    term: '分红',
    definition: '按派发日计入，已扣预扣税。是否摊薄成本由「分红计入成本」设置决定。',
  },
  fees: {
    term: '费用',
    definition: '券商佣金、平台费与账户级订阅费；已从合计中扣除。',
  },
  adjustments: {
    term: '调整 / 利息',
    definition: '现金调整、利息收入与融资利息；计入合计但不属于战役权利金。',
  },
  annualTotal: {
    term: '年度合计',
    definition: '净收租 + 股票已实现盈亏 + 分红 − 费用 + 调整/利息，仅含已实现项目。',
  },
  costA: {
    term: 'A 纯股票成本',
    definition: '只按股票买入价与买入费用计算，不扣任何期权权利金或分红。',
  },
  costB: {
    term: 'B 已落袋有效成本',
    definition: 'A 轨成本扣除已了结期权的净权利金（并按设置处理分红），反映当前持股的真实成本。',
  },
  costC: {
    term: 'C′ 含未平仓成本',
    definition: '在 B 轨基础上再扣除未平仓期权的净权利金；假设这些期权到期作废时的成本。',
  },
  premiumRealized: {
    term: '已落袋权利金',
    definition: '已经了结的期权行净收入，已扣开仓与平仓费用。',
  },
  premiumOpen: {
    term: '未平仓权利金',
    definition: '仍持有合约的净卖出权利金；尚未了结，不计入已实现收益。',
  },
  realizedPnl: {
    term: '本轮总收益',
    definition: '战役结束时的已实现合计：期权净收租 + 股票已实现盈亏 + 分红 + 调整 − 费用。',
  },
  collateral: {
    term: 'Put 资金义务',
    definition: '卖出 Put 按行权价 × 手数 × 每手股数计算的最大接货现金需求。',
  },
} as const;

export type GlossaryId = keyof typeof GLOSSARY;

/** A label with an inline `?` that explains the metric in place. */
export function GlossaryTerm({ id, children }: { id: GlossaryId; children?: ReactNode }) {
  const entry = GLOSSARY[id];
  return (
    <span className="glossary-term inline-flex items-center gap-1">
      {children ?? entry.term}
      <span
        className="glossary-help inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full border text-[10px] leading-none text-muted-foreground"
        role="note"
        tabIndex={0}
        title={entry.definition}
        aria-label={`${entry.term}：${entry.definition}`}
      >
        ?
      </span>
    </span>
  );
}
