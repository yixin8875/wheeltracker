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
export interface Holding {
  accountId: string; accountName: string; campaignId: string; symbol: string; shares: number;
  costA: number | null; costB: number | null; costC: number | null;
  price: number | null; marketValue: number | null; costBasis: number | null;
  unrealizedPnl: number | null; unrealizedPct: number | null;
  premiumRealized: number; premiumOpen: number; dividends: number; startedAt: string;
}
export interface HoldingOption {
  accountId: string; accountName: string; campaignId: string; symbol: string; contract: string;
  right: string; strike: number; expiry: string; daysLeft: number; openQty: number;
  multiplier: number; avgCredit: number; collateral: number;
  mark: number | null; chainStatus: string; chainFetchedAt: string | null;
  closeCost: number | null; unrealizedPnl: number | null; unrealizedPct: number | null;
  collateralReturnPct: number | null;
}
export interface HoldingsTotals {
  accountCount: number; holdingCount: number; pricedHoldings: number; unpricedHoldings: number;
  totalShares: number; marketValue: number; costBasis: number; unrealizedPnl: number;
  unrealizedPct: number | null; premiumRealized: number; premiumOpen: number;
  optionCount: number; openContracts: number; optionCollateral: number;
  optionPricedCount: number; optionUnpricedCount: number; optionCloseCost: number;
  optionUnrealizedPnl: number; optionUnrealizedPct: number | null;
}
export interface AllHoldings { asOf: string; holdings: Holding[]; options: HoldingOption[]; totals: HoldingsTotals }
export interface Entry { id: string; campaignId: string; symbol: string; contract: string; right: string; multiplier: number; qty: number; openQty: number; openedAt: string; closedAt: string | null; status: string; premiumGross: number; fees: number; closeCost: number; netPremium: number; collateral: number; daysHeld: number | null; annualizedReturn: number | null }
export interface Position extends OptionSummary {
  campaignId: string; symbol: string; openedAt: string;
  mark: number | null; chainStatus: string; chainFetchedAt: string | null;
  closeCost: number | null; unrealizedPnl: number | null; unrealizedPct: number | null;
  collateralReturnPct: number | null;
}
export interface Lot { id: string; symbol: string; openedAt: string; qty: number; remainingQty: number; costPerShare: number }
export interface AlertRules {
  alertsEnabled: boolean;
  expiryDays: number;
  profitTargetPct: number;
  deepItmPct: number;
  belowCostPct: number;
}
export interface AccountingSettings { includeDividendsInCost: boolean; reminderLeadDays: number; autoBackupEnabled: boolean; autoBackupKeep: number; systemNotificationsEnabled: boolean; closeToTray: boolean; alertRules: AlertRules }
export interface ExpiryCheckSummary { overdue: number; today: number; critical: number; soon: number; total: number; notified: number; alerts: number; alertNotified: number }
export type InsightSeverity = 'urgent' | 'warning' | 'info';
export type InsightKind = 'overdue' | 'expiry' | 'profit' | 'deep_itm' | 'cash' | 'below_cost';
export type InsightAction = 'expire' | 'close' | 'roll' | 'cost' | 'cash';
export interface InsightItem {
  id: string;
  severity: InsightSeverity;
  kind: InsightKind;
  accountId: string;
  accountName: string;
  symbol: string;
  campaignId: string | null;
  contract: string | null;
  title: string;
  detail: string;
  action: InsightAction;
  qty: number | null;
  expiry: string | null;
  strike: number | null;
  right: string | null;
  multiplier: number | null;
  daysLeft: number | null;
}
export interface TodoView { asOf: string; rules: AlertRules; items: InsightItem[] }
export interface WatchlistView { symbols: string[] }
export interface CspCandidate {
  symbol: string; expiry: string; dte: number; strike: number; right: string;
  perShare: number; priceSource: 'bid' | 'mark'; qty: number; cashRequired: number;
  premiumTotal: number; fees: number; annualized: number; delta: number | null;
  probItm: number | null; breakeven: number; otmPct: number;
  openInterest: number | null; multiplier: number; flags: ScanFlag[];
}
export interface WatchlistOutcome {
  symbol: string; chainStale: boolean; scannedQuotes: number; filters: ScanFilters;
  candidates: CspCandidate[];
}
export interface WatchlistSymbol {
  symbol: string; price: number | null; chainStatus: ChainFreshness;
  error: string | null; outcome: WatchlistOutcome | null;
}
export interface WatchlistScanView {
  asOf: string; accountId: string; accountName: string;
  cash: number | null; cashTracked: boolean; symbols: WatchlistSymbol[];
}
export interface VisionSettings {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyHint: string;
  enabled: boolean;
  consent: boolean;
}
export type BackupKind = 'manual' | 'auto' | 'safety' | 'unknown';

export type ScanPreset = 'steady_income' | 'balanced' | 'aggressive' | 'add_position';
export type ScanFlag = 'locks_loss' | 'adds_shares' | 'insufficient_cash' | 'partial_coverage' | 'deep_itm' | 'near_expiry' | 'illiquid' | 'chain_stale' | 'estimated_price' | 'dividend_near';
export type StrategyKind = 'covered_call' | 'cash_secured_put';
export interface ScanSettings {
  dteMin: number; dteMax: number; deltaMin: number; deltaMax: number;
  allowLockedLoss: boolean; allowPuts: boolean; maxSharesMultiple: number;
  maxExtraCapital: number | null; feePerContract: number;
  priceSource: 'bid' | 'mark'; liquidityFilter: boolean; minOpenInterest: number;
  maxSpreadPct: number; riskFreeRate: number; dividendYield: number;
  putMaxStrikeRatio: number; preset: ScanPreset; projectionLimit: number;
}
export interface ScanLeg { side: 'short'; expiry: string; strike: number; right: string; qty: number; price: number; priceSource: 'bid' | 'mark'; multiplier: number }
export interface ScanAssignment {
  sharesAfter: number; sharesChange: number; costBAfter: number | null; realizedPnl: number;
  lockedLoss: number; remainingShares: number; remainingCostB: number | null;
  closesCampaign: boolean; saleProceeds: number; capitalAdded: number;
}
export interface ScanStress { price: number; pnl: number; baselinePnl: number }
export interface ScanCandidate {
  id: string; kind: StrategyKind; legs: ScanLeg[]; premiumTotal: number; fees: number;
  costBAfter: number | null; costCAfter: number | null; costReductionPerShare: number;
  breakeven: number | null; annualized: number; probItm: number | null; delta: number | null;
  upsideCap: number | null; capital: number; assignment: ScanAssignment | null;
  stress: ScanStress[]; flags: ScanFlag[];
}
export interface ScanCampaign {
  id: string; symbol: string; shares: number; costA: number | null; costB: number | null;
  costC: number | null; price: number; unrealizedPnl: number | null; unrealizedPct: number | null;
  premiumRealized: number; coveredShares: number; freeShares: number; cash: number; cashTracked: boolean;
}
export interface ScanFilters {
  totalQuotes: number; invalidQuotes: number; outsideDte: number;
  callsDisabled: number; putsDisabled: number; missingPrice: number;
  illiquid: number; outsideDelta: number; belowCost: number;
  putStrikeTooHigh: number; noQuantity: number; noPremium: number;
}
export interface ScanOutcome {
  campaign: ScanCampaign; chainStale: boolean; scannedQuotes: number; dropped: number;
  filters: ScanFilters;
  candidates: ScanCandidate[];
}
export type ChainFreshness = 'fresh' | 'delayed' | 'stale' | 'missing';
export interface ChainStatus {
  symbol: string; source: string; asOf: string; fetchedAt: string; underlying: number | null;
  quoteCount: number; status: ChainFreshness; notes: string;
}
export interface ChainQuoteRow {
  expiry: string; strike: number; right: string; bid: number | null; ask: number | null;
  last: number | null; mark: number | null; iv: number | null; openInterest: number | null; volume: number | null;
}
export interface ChainImportPreview {
  headers: string[]; delimiter: string; rows: ChainQuoteRow[];
  errors: { line: number; message: string }[]; valid: number; invalid: number;
}
export interface ChainSync { status: ChainStatus; imported: number; skipped: number }
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
export interface AccountReport { accountId: string; accountName: string; monthly: MonthlyIncome; annual: AnnualReport }
export interface AllAccountsReports { asOf: string; accounts: AccountReport[]; monthly: MonthlyIncome; annual: AnnualReport }
export interface AuditSnapshot {
  date: string; kind: string; symbol: string;
  expiry: string | null; strike: number | null; right: string | null; multiplier: number | null;
  qty: number; price: number; fees: number; amount: number; note: string;
}
export type AuditAction = 'insert' | 'update' | 'delete';
export interface AuditEntry {
  id: number; eventId: string; accountId: string; accountName: string;
  action: AuditAction; recordedAt: string;
  before: AuditSnapshot | null; after: AuditSnapshot | null;
}
export interface AuditLog { entries: AuditEntry[] }
export interface BrokerPreset { id: string; name: string; note: string }
export interface OnboardingStatus {
  needed: boolean; hasEvents: boolean; accountCount: number; demoAccountId: string | null;
}
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
export interface ImportPreview { headers: string[]; signature: string; delimiter: string; headerLine: number; mapping: ColumnMapping; mappingSource: 'detected' | 'saved' | 'manual' | 'vision' | 'preset'; rows: CandidateRow[]; counts: ImportCounts; warnings: string[] }
export interface ImportSummary { imported: number; eventIds: string[]; accountId: string; notePrefix: string; duplicateCount: number; batchId: string | null; batchSaved: boolean }
export interface ImportBatch { id: string; origin: string; createdAt: string; imported: number; remaining: number; undoneAt: string | null; undoneCount: number }

export interface WebDavConfig {
  url: string; username: string; remoteDir: string;
  autoUpload: boolean; keep: number; encrypt: boolean; allowInsecureHttp: boolean;
}
export type WebDavPasswordSource = 'keychain' | 'session' | 'none';
export interface WebDavSettings extends WebDavConfig {
  configured: boolean; hasPassword: boolean; passwordSource: WebDavPasswordSource; passwordHint: string;
  lastUploadAt: string | null; lastUploadFile: string | null; lastError: string | null; autoUploadReady: boolean;
}
export interface WebDavStatus {
  configured: boolean; hasPassword: boolean; passwordSource: string;
  lastUploadAt: string | null; lastUploadFile: string | null; lastError: string | null;
  autoUploadReady: boolean; busy: boolean;
}
export interface RemoteBackup { fileName: string; sizeBytes: number; modifiedAt: string | null; etag: string | null; encrypted: boolean }
export interface WebDavServerInfo { server: string | null; snapshotCount: number; writable: boolean }
export interface WebDavDownload { validation: BackupValidation; localFile: string }
export interface WebDavUpload { remote: RemoteBackup; sha256: string }
