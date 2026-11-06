export interface CostPoint { at: string; shares: number; premiumRealized: number; premiumOpen: number; costA: number; costB: number; costC: number }
export interface OptionSummary { contract: string; right: string; strike: number; expiry: string; daysLeft: number; openQty: number; multiplier: number; avgCredit: number }
export interface Campaign {
  id: string; symbol: string; status: string; shares: number;
  costA: number | null; costB: number | null; costC: number | null;
  premiumRealized: number; premiumOpen: number; dividends: number; adjustments: number;
  price: number | null; safetyMargin: number | null; nextOption: OptionSummary | null;
  realizedPnl: number | null; sharePnl: number; startedAt: string; endedAt: string | null;
  cycles: number; costPoints: CostPoint[];
}
export interface Summary {
  premiumRealized: number; premiumOpen: number; activeCampaigns: number; openPositions: number;
  openContracts: number; collateral: number; sharesHeld: number;
  accountCash: number; cashDeposits: number; cashWithdrawals: number; cashTracked: boolean;
  cashCoverage: number | null; cashShortfall: number;
}
export interface CashMovement { date: string; kind: string; symbol: string; note: string; amount: number; balanceAfter: number }
export interface Dashboard { accountId: string; asOf: string; summary: Summary; campaigns: Campaign[] }
export interface OverviewAccount extends Summary { id: string; name: string }
export interface OverviewTotals {
  accountCount: number; cashTrackedAccounts: number; untrackedAccounts: number; untrackedPutAccounts: number;
  premiumRealized: number; premiumOpen: number; activeCampaigns: number; openPositions: number;
  openContracts: number; collateral: number; trackedCollateral: number; sharesHeld: number;
  accountCash: number; cashDeposits: number; cashWithdrawals: number;
  cashCoverage: number | null; cashShortfall: number;
}
export interface AllAccountsOverview { asOf: string; accounts: OverviewAccount[]; totals: OverviewTotals }
export interface Entry { id: string; campaignId: string; symbol: string; contract: string; right: string; multiplier: number; qty: number; openQty: number; openedAt: string; closedAt: string | null; status: string; premiumGross: number; fees: number; closeCost: number; netPremium: number; collateral: number; daysHeld: number | null; annualizedReturn: number | null }
export interface Position extends OptionSummary { campaignId: string; symbol: string; openedAt: string }
export interface Lot { id: string; symbol: string; openedAt: string; qty: number; remainingQty: number; costPerShare: number }
export interface AccountingSettings { includeDividendsInCost: boolean; reminderLeadDays: number; autoBackupEnabled: boolean; autoBackupKeep: number; systemNotificationsEnabled: boolean; closeToTray: boolean }
export interface ExpiryCheckSummary { overdue: number; today: number; critical: number; soon: number; total: number; notified: number }
export interface VisionSettings {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyHint: string;
  enabled: boolean;
  consent: boolean;
}
export type BackupKind = 'manual' | 'auto' | 'safety' | 'unknown';
export interface Backup { fileName: string; kind: BackupKind; sizeBytes: number; modifiedAt: string | null; encrypted: boolean }
export interface BackupValidation { fileName: string; valid: boolean; integrity: string; events: number; accounts: number; prices: number; issues: string[] }
export interface PendingRestore { version: number; backupFile: string; safetyFile: string; requestedAt: string; stagedFile: string | null }
export interface RestoreResult { ok: boolean; message: string; at: string; backupFile: string | null; safetyFile: string | null }
export interface RestoreStatus { pending: PendingRestore | null; lastResult: RestoreResult | null; failed: string[] }
export interface CallScenario {
  contract: string; qty: number; sharesSold: number; strike: number; assignmentFees: number;
  saleProceeds: number; sharePnl: number; premiumRealized: number; dividends: number;
  adjustments: number; realizedTotal: number; remainingShares: number;
  remainingContracts: number; closesCampaign: boolean;
}
export interface Detail { campaign: Campaign; entries: Entry[]; positions: Position[]; lots: Lot[]; events: EventRow[]; callScenarios: CallScenario[] }
export interface Ledger { entries: Entry[]; totalNet: number; totalCollateral: number; count: number }
export interface MonthIncome { month: string; premium: number; dividends: number; fees: number; adjustments: number; total: number; cumulative: number; closedEntries: number }
export interface MonthIncomeTotal { premium: number; dividends: number; fees: number; adjustments: number; total: number; closedEntries: number; monthCount: number }
export interface MonthlyIncome { months: MonthIncome[]; total: MonthIncomeTotal }
export interface AnnualMonth { month: string; premium: number; sharePnl: number; dividends: number; fees: number; adjustments: number; total: number; cumulative: number; closedEntries: number; shareEvents: number }
export interface AnnualSymbol { symbol: string; premium: number; sharePnl: number; dividends: number; fees: number; adjustments: number; total: number }
export interface AnnualTotal { premium: number; sharePnl: number; dividends: number; fees: number; adjustments: number; total: number; closedEntries: number; shareEvents: number }
export interface AnnualYear { year: number; months: AnnualMonth[]; symbols: AnnualSymbol[]; total: AnnualTotal }
export interface AnnualReport { availableYears: number[]; years: AnnualYear[] }
export interface Price { symbol: string; date: string; close: number; source: string; quotedAt: string | null }
export interface SymbolMatch { symbol: string; name: string; exchange: string }
export interface MarketQuote { symbol: string; name: string; price: number; previousClose: number | null; changePercent: number | null; quotedAt: string; source: string; currency: string }
export interface QuoteRefresh { updated: Price[]; failed: { symbol: string; error: string }[] }
export interface Account { id: string; name: string; broker: string | null; currency: string; createdAt: string; archivedAt: string | null; eventCount: number }
export interface AppInfo { version: string; dbPath: string }
export interface NewEvent { date: string; kind: string; symbol: string; qty: number; price: number; fees: number; amount: number; expiry?: string; strike?: number; right?: string; multiplier?: number; splitNumerator?: number; splitDenominator?: number; splitCashInLieu?: number; note?: string; accountId?: string }
export interface EventRow { id: string; date: string; kind: string; symbol: string; qty: number; price: number; fees: number; amount: number; note: string; expiry: string | null; strike: number | null; right: string | null; multiplier: number | null; splitNumerator: number | null; splitDenominator: number | null; splitCashInLieu: number | null }

export type ImportField = 'date' | 'kind' | 'action' | 'symbol' | 'optionSymbol' | 'qty' | 'price' | 'fees' | 'amount' | 'expiry' | 'strike' | 'right' | 'multiplier' | 'note';
export type ImportDelimiter = 'comma' | 'semicolon' | 'tab';
export type ImportDateFormat = 'auto' | 'yearMonthDay' | 'monthDayYear' | 'chinese';
export interface ColumnMapping {
  fields: Partial<Record<ImportField, number>>;
  dateFormat: ImportDateFormat;
  delimiter: ImportDelimiter | null;
  hasHeader: boolean | null;
}
export interface CandidateEvent { date: string; kind: string; symbol: string; qty: number; price: number; fees: number; amount: number; expiry: string | null; strike: number | null; right: string | null; multiplier: number; note: string | null }
export type RowStatus = 'ok' | 'warning' | 'duplicate' | 'error';
export interface CandidateRow { rowNumber: number; line: number; status: RowStatus; messages: string[]; cells: string[]; raw: string; event: CandidateEvent | null; selectedByDefault: boolean }
export interface ImportCounts { total: number; ok: number; warning: number; duplicate: number; error: number; selected: number }
export interface ImportPreview { headers: string[]; signature: string; delimiter: string; headerLine: number; mapping: ColumnMapping; mappingSource: 'detected' | 'saved' | 'manual' | 'vision'; rows: CandidateRow[]; counts: ImportCounts; warnings: string[] }
export interface ImportSummary { imported: number; eventIds: string[]; accountId: string; notePrefix: string; duplicateCount: number; batchId: string | null; batchSaved: boolean }
export interface ImportBatch { id: string; origin: string; createdAt: string; imported: number; remaining: number; undoneAt: string | null; undoneCount: number }
