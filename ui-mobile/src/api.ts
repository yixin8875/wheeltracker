import { invoke } from '@tauri-apps/api/core'

export interface Account {
  id: string
  name: string
  broker: string | null
  eventCount: number
  archived: boolean
}

export interface Bootstrap {
  accountId: string
  today: string
  dbPath: string
  demo: boolean
  accounts: Account[]
}

export interface Summary {
  premiumRealized: number
  premiumOpen: number
  activeCampaigns: number
  openPositions: number
  openContracts: number
  collateral: number
  sharesHeld: number
  accountCash: number
  cashDeposits: number
  cashWithdrawals: number
  cashTracked: boolean
  cashCoverage: number | null
  cashShortfall: number
}

export interface OptionSummary {
  contract: string
  right: string
  strike: number
  expiry: string
  daysLeft: number
  openQty: number
  multiplier: number
  avgCredit: number
}

export interface CostPoint {
  at: string
  shares: number
  premiumRealized: number
  premiumOpen: number
  costA: number
  costB: number
  costC: number
}

export interface Campaign {
  id: string
  symbol: string
  status: string
  shares: number
  costA: number | null
  costB: number | null
  costC: number | null
  premiumRealized: number
  premiumOpen: number
  dividends: number
  adjustments: number
  price: number | null
  safetyMargin: number | null
  nextOption: OptionSummary | null
  realizedPnl: number | null
  sharePnl: number
  startedAt: string
  endedAt: string | null
  cycles: number
  costPoints: CostPoint[]
}

export interface Position {
  campaignId: string
  symbol: string
  contract: string
  right: string
  strike: number
  expiry: string
  daysLeft: number
  openQty: number
  multiplier: number
  avgCredit: number
  openedAt: string
}

export interface Lot {
  id: string
  symbol: string
  openedAt: string
  qty: number
  remainingQty: number
  costPerShare: number
}

export interface Overview {
  accountId: string
  asOf: string
  dbPath: string
  demo: boolean
  summary: Summary
  campaigns: Campaign[]
  positions: Position[]
  lots: Lot[]
  accounts: Account[]
}

export type EntryKind =
  | 'option_open_short'
  | 'option_close'
  | 'option_expire'
  | 'option_assign'
  | 'shares_buy'
  | 'shares_sell'
  | 'dividend'
  | 'fee'
  | 'adjustment'
  | 'cash_deposit'
  | 'cash_withdrawal'

export interface NewEventReq {
  accountId?: string | null
  date: string
  kind: EntryKind
  symbol: string
  qty: number
  price: number
  fees: number
  amount: number
  expiry?: string | null
  strike?: number | null
  right?: 'P' | 'C' | null
  multiplier?: number | null
  splitNumerator?: number | null
  splitDenominator?: number | null
  splitCashInLieu?: number | null
  note?: string | null
}

export function hasTauri() {
  return '__TAURI_INTERNALS__' in window
}

/**
 * Design-only data for `npm run dev` in a plain browser. Never used in a Tauri
 * build: `import.meta.env.DEV` is false there and every call goes over IPC.
 */
const DEV_OVERVIEW: Overview = {
  accountId: 'main',
  asOf: '2026-11-12',
  dbPath: '浏览器预览 · 不读取本机数据库',
  demo: true,
  summary: {
    premiumRealized: 1240.5,
    premiumOpen: 320,
    activeCampaigns: 2,
    openPositions: 2,
    openContracts: 2,
    collateral: 15000,
    sharesHeld: 200,
    accountCash: 28400,
    cashDeposits: 40000,
    cashWithdrawals: 0,
    cashTracked: true,
    cashCoverage: 1.89,
    cashShortfall: 0,
  },
  campaigns: [
    {
      id: 'c-aapl',
      symbol: 'AAPL',
      status: 'active',
      shares: 100,
      costA: 152.4,
      costB: 146,
      costC: 144.5,
      premiumRealized: 840.5,
      premiumOpen: 150,
      dividends: 24,
      adjustments: 0,
      price: 171.2,
      safetyMargin: 0.172,
      nextOption: {
        contract: 'AAPL 2026-12-18 160 C',
        right: 'C',
        strike: 160,
        expiry: '2026-12-18',
        daysLeft: 36,
        openQty: 1,
        multiplier: 100,
        avgCredit: 1.5,
      },
      realizedPnl: 240,
      sharePnl: 0,
      startedAt: '2026-09-01',
      endedAt: null,
      cycles: 2,
      costPoints: [],
    },
    {
      id: 'c-msft',
      symbol: 'MSFT',
      status: 'active',
      shares: 100,
      costA: 398,
      costB: 391.2,
      costC: 389.7,
      premiumRealized: 400,
      premiumOpen: 170,
      dividends: 0,
      adjustments: 0,
      price: 402.6,
      safetyMargin: 0.029,
      nextOption: {
        contract: 'MSFT 2026-12-05 380 P',
        right: 'P',
        strike: 380,
        expiry: '2026-12-05',
        daysLeft: 23,
        openQty: 1,
        multiplier: 100,
        avgCredit: 1.7,
      },
      realizedPnl: 0,
      sharePnl: 0,
      startedAt: '2026-10-02',
      endedAt: null,
      cycles: 1,
      costPoints: [],
    },
  ],
  positions: [
    {
      campaignId: 'c-msft',
      symbol: 'MSFT',
      contract: 'MSFT 2026-12-05 380 P',
      right: 'P',
      strike: 380,
      expiry: '2026-12-05',
      daysLeft: 23,
      openQty: 1,
      multiplier: 100,
      avgCredit: 1.7,
      openedAt: '2026-10-02',
    },
    {
      campaignId: 'c-aapl',
      symbol: 'AAPL',
      contract: 'AAPL 2026-12-18 160 C',
      right: 'C',
      strike: 160,
      expiry: '2026-12-18',
      daysLeft: 36,
      openQty: 1,
      multiplier: 100,
      avgCredit: 1.5,
      openedAt: '2026-10-23',
    },
  ],
  lots: [
    {
      id: 'l-aapl',
      symbol: 'AAPL',
      openedAt: '2026-09-18',
      qty: 100,
      remainingQty: 100,
      costPerShare: 152.4,
    },
    {
      id: 'l-msft',
      symbol: 'MSFT',
      openedAt: '2026-10-02',
      qty: 100,
      remainingQty: 100,
      costPerShare: 398,
    },
  ],
  accounts: [
    { id: 'main', name: '主账户', broker: 'IBKR', eventCount: 12, archived: false },
  ],
}

function devMode() {
  return !hasTauri() && import.meta.env.DEV
}

export async function bootstrap() {
  if (devMode()) {
    return {
      accountId: DEV_OVERVIEW.accountId,
      today: DEV_OVERVIEW.asOf,
      dbPath: DEV_OVERVIEW.dbPath,
      demo: true,
      accounts: DEV_OVERVIEW.accounts,
    } satisfies Bootstrap
  }
  return invoke<Bootstrap>('mobile_bootstrap')
}

export async function overview(accountId?: string) {
  if (devMode()) return DEV_OVERVIEW
  return invoke<Overview>('mobile_overview', { accountId: accountId ?? null })
}

export async function addEvent(req: NewEventReq) {
  if (devMode()) {
    console.info('dev mock addEvent', req)
    return 'dev-mock'
  }
  return invoke<string>('mobile_add_event', { req })
}
