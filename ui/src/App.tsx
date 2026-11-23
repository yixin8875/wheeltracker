import { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutDashboard, Layers, BookOpen, Plus, AlarmClock, RefreshCw, ArrowLeft, ChevronRight, Activity, Upload, CalendarDays, ChartColumn, Wallet, Table2, TrendingDown } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToastProvider } from '@/components/ui/toast';
import { AppSidebar, type NavGroup } from '@/components/app-sidebar';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Footnote, Stat, StatGrid } from '@/components/page-kit';
import { MarketPage, usePortfolioQuotes, latestPrice, quoteTime } from './MarketData';
import type { Account, AllAccountsOverview, AllHoldings, AnnualReport, AppInfo, Campaign, Dashboard, Detail, EventRow, Ledger, MonthlyIncome, NewEvent, Position, Price, RestoreStatus } from './types';
import { api, chainStatusLabel, chainTime, desktop, labels, money, percent, pnlLabel, pnlTone, today } from './lib';
import { CostChart } from './CostChart';
import { LedgerTable } from './LedgerTable';
import { EventLog } from './EventLog';
import { EntryForm, type NextLeg } from './EntryForm';
import { AccountingPreferences, CampaignTimeline, CallAssignmentScenarios } from './CampaignInsights';
import type { AccountingSettings } from './types';
import { ImportWizard } from './ImportWizard';
import { ReminderCard, ReminderPreferences, reminderPositions } from './Reminders';
import { ExpiryCalendar } from './ExpiryCalendar';
import { ExpiryCenter } from './ExpiryCenter';
import { CampaignCompare } from './CampaignCompare';
import { SettingsData } from './SettingsData';
import { VisionSettings } from './VisionSettings';
import { AccountsPanel } from './Accounts';
import { AccountCashPanel, ReconcileModal } from './AccountCash';
import { AccountsOverview } from './AccountsOverview';
import { AllHoldingsPage } from './AllHoldings';
import { MonthlyIncomeReport } from './MonthlyIncome';
import { AnnualReportPage } from './AnnualReport';
import { Updater } from './Updater';
import { UpdateProvider } from './update';
import { AboutPanel } from './AboutPanel';
import { CostReduction } from './CostReduction';
import { useOptionQuotes } from './hooks/useOptionQuotes';

const ACCOUNT_KEY = 'wheel.account';
type Page = 'dashboard' | 'positions' | 'cost' | 'ledger' | 'entry' | 'import' | 'overview' | 'holdings' | 'expiry' | 'calendar' | 'reports' | 'market' | 'settings' | 'detail';
type ReportTab = 'income' | 'annual' | 'compare';
const navigation: NavGroup[] = [
  { id: 'daily', title: '日常', items: [
    { id: 'dashboard', label: '仪表盘', icon: LayoutDashboard },
    { id: 'positions', label: '当前持仓', icon: Layers },
    { id: 'cost', label: '降本扫描', icon: TrendingDown },
  ] },
  { id: 'books', title: '账本', items: [
    { id: 'ledger', label: '收租台账', icon: BookOpen },
    { id: 'import', label: '导入', icon: Upload },
  ] },
  { id: 'review', title: '复盘', items: [
    { id: 'reports', label: '报告', icon: ChartColumn },
    { id: 'expiry', label: '到期处理', icon: AlarmClock },
    { id: 'calendar', label: '到期日历', icon: CalendarDays },
    { id: 'overview', label: '账户总览', icon: Wallet },
    { id: 'holdings', label: '跨账户持仓', icon: Table2 },
    { id: 'market', label: '行情', icon: Activity },
  ] },
];
const navigationItems = navigation.flatMap(group => group.items);

export default function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const [data, setData] = useState<Dashboard | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [income, setIncome] = useState<MonthlyIncome | null>(null);
  const [annual, setAnnual] = useState<AnnualReport | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [prices, setPrices] = useState<Price[]>([]);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState(() => {
    try { return localStorage.getItem(ACCOUNT_KEY) ?? 'main'; } catch { return 'main'; }
  });
  const [settings, setSettings] = useState<AccountingSettings | null>(null);
  const [overview, setOverview] = useState<AllAccountsOverview | null>(null);
  const [overviewBusy, setOverviewBusy] = useState(false);
  const [overviewError, setOverviewError] = useState('');
  const [holdings, setHoldings] = useState<AllHoldings | null>(null);
  const [holdingsBusy, setHoldingsBusy] = useState(false);
  const [holdingsError, setHoldingsError] = useState('');
  const [restoreStatus, setRestoreStatus] = useState<RestoreStatus | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [scanCampaign, setScanCampaign] = useState<string | null>(null);
  const [initial, setInitial] = useState<Partial<NewEvent>>();
  const [initialRoll, setInitialRoll] = useState(false);
  const [initialNext, setInitialNext] = useState<Partial<NextLeg>>();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [entryKey, setEntryKey] = useState(0);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false); const [archive, setArchive] = useState(false); const [symbol, setSymbol] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null); const [deleting, setDeleting] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const generation = useRef(0); const detailGeneration = useRef(0);
  const loadOverview = useCallback(async () => {
    if (!desktop) return;
    setOverviewBusy(true); setOverviewError('');
    try { setOverview(await api<AllAccountsOverview>('all_accounts_overview')); }
    catch (failure) { setOverview(null); setOverviewError(String(failure)); }
    finally { setOverviewBusy(false); }
  }, []);
  const loadHoldings = useCallback(async () => {
    if (!desktop) return;
    setHoldingsBusy(true); setHoldingsError('');
    try { setHoldings(await api<AllHoldings>('all_holdings_overview')); }
    catch (failure) { setHoldings(null); setHoldingsError(String(failure)); }
    finally { setHoldingsBusy(false); }
  }, []);
  const reload = useCallback(async () => {
    if (!desktop) return false;
    const current = ++generation.current; setBusy(true); setError('');
    try {
      const scope = { accountId };
      const [dashboard, book, options, history, report, annualReport, quotes, preferences, metadata, restore] = await Promise.all([
        api<Dashboard>('dashboard', scope), api<Ledger>('ledger', scope), api<Position[]>('positions', scope), api<EventRow[]>('list_events', scope), api<MonthlyIncome>('monthly_income', scope), api<AnnualReport>('annual_report', scope), api<Price[]>('list_prices'), api<AccountingSettings>('get_settings'),
        api<AppInfo>('app_info').then(value => ({ value, error: '' }), failure => ({ value: null, error: String(failure) })),
        api<RestoreStatus>('restore_status').catch(() => null),
      ]);
      if (current !== generation.current) return false;
      setData(dashboard); setLedger(book); setIncome(report); setAnnual(annualReport); setPositions(options.sort((a, b) => a.expiry.localeCompare(b.expiry))); setEvents(history); setPrices(quotes); setSettings(preferences); setUnavailable(false);
      setRestoreStatus(restore ?? { pending: null, lastResult: null, failed: [] });
      if (metadata.value) setInfo(metadata.value);
      else setError(`账本已更新，但应用信息读取失败：${metadata.error}`);
      return true;
    } catch (failure) {
      if (current === generation.current) {
        detailGeneration.current++;
        setData(null); setLedger(null); setIncome(null); setAnnual(null); setPositions([]); setEvents([]); setPrices([]); setDetail(null); setUnavailable(true); setError(String(failure));
      }
      return false;
    } finally { if (current === generation.current) setBusy(false); }
  }, [accountId]);
  const activeSymbols = [...new Set((data?.campaigns ?? []).filter(campaign => campaign.status === 'active').map(campaign => campaign.symbol))];
  const market = usePortfolioQuotes(activeSymbols, reload);
  const optionQuotes = useOptionQuotes(
    positions.map(position => ({ symbol: position.symbol, expiry: position.expiry })),
    reload,
    page === 'positions' && !restoreStatus?.pending,
  );
  const [settingsTab, setSettingsTab] = useState<'accounting' | 'accounts' | 'reminders' | 'vision' | 'data' | 'about'>('accounting');
  const [ledgerTab, setLedgerTab] = useState<'entries' | 'events'>('entries');
  const [reportTab, setReportTab] = useState<ReportTab>('income');
  useEffect(() => { void reload(); return () => { generation.current++; }; }, [reload]);
  useEffect(() => { if (page === 'overview') void loadOverview(); }, [page, data, accounts, loadOverview]);
  useEffect(() => { if (page === 'holdings') void loadHoldings(); }, [page, data, accounts, loadHoldings]);
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    api<Account[]>('list_accounts').then(list => {
      if (cancelled) return;
      setAccounts(list);
      const active = list.filter(account => !account.archivedAt);
      if (active.length && !active.some(account => account.id === accountId)) {
        try { localStorage.setItem(ACCOUNT_KEY, active[0].id); } catch { /* storage unavailable in preview */ }
        setAccountId(active[0].id);
      }
    }).catch(failure => { if (!cancelled) setError(`账户列表读取失败：${failure}`); });
    return () => { cancelled = true; };
    // The stored account is only validated once; later switches are user driven.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!selected || !desktop || !data) return;
    const current = ++detailGeneration.current; setDetail(null);
    api<Detail>('campaign_detail', { campaignId: selected, accountId }).then(result => { if (current === detailGeneration.current) setDetail(result); }).catch(failure => { if (current === detailGeneration.current) setError(String(failure)); });
    return () => { detailGeneration.current++; };
  }, [selected, data, accountId]);
  const startEntry = useCallback((prefill?: Partial<NewEvent>, options?: { roll?: boolean; next?: Partial<NextLeg> }) => {
    setEditingId(null); setInitial(prefill); setInitialRoll(Boolean(options?.roll)); setInitialNext(options?.next); setEntryKey(key => key + 1); setPage('entry');
  }, []);
  function editEvent(event: EventRow) {
    setEditingId(event.id);
    setInitial({
      date: event.date,
      kind: event.kind,
      symbol: event.symbol,
      qty: event.qty,
      price: event.price,
      fees: event.fees,
      amount: event.amount,
      expiry: event.expiry ?? '',
      strike: event.strike ?? 0,
      right: event.right ?? 'P',
      multiplier: event.multiplier ?? 100,
      splitNumerator: event.splitNumerator ?? 2,
      splitDenominator: event.splitDenominator ?? 1,
      splitCashInLieu: event.splitCashInLieu ?? undefined,
      note: event.note,
    });
    setEntryKey(key => key + 1);
    setPage('entry');
  }
  function cancelEdit() { setEditingId(null); setInitial(undefined); setPage('ledger'); setLedgerTab('events'); }
  function editSaved(message: string) { saved(message); setEditingId(null); setInitial(undefined); setPage('ledger'); setLedgerTab('events'); }
  useEffect(() => { const handler = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); startEntry(); } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [startEntry]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(timer); }, [notice]);
  function openCampaign(id: string) { setSelected(id); setPage('detail'); }
  function openCostScan(campaignId?: string) { setScanCampaign(campaignId ?? null); setPage('cost'); }
  function openHolding(targetAccount: string, campaignId: string) {
    if (targetAccount !== accountId) {
      try { localStorage.setItem(ACCOUNT_KEY, targetAccount); } catch { /* storage unavailable in preview */ }
      setAccountId(targetAccount);
    }
    setSelected(campaignId); setPage('detail');
  }
  function navigate(next: Page) { setPage(next); if (next === 'entry') startEntry(); }
  function switchAccount(id: string) {
    if (id === accountId) return;
    try { localStorage.setItem(ACCOUNT_KEY, id); } catch { /* storage unavailable in preview */ }
    setAccountId(id); setSelected(null); setDetail(null);
    if (page === 'detail') setPage('dashboard');
  }
  const currentAccount = accounts.find(account => account.id === accountId) ?? null;
  const activeAccounts = accounts.filter(account => !account.archivedAt);
  function saved(message: string) { setNotice(message); void reload(); }
  async function settingsSaved(result: AccountingSettings) {
    generation.current++; detailGeneration.current++;
    setData(null); setLedger(null); setIncome(null); setPositions([]); setEvents([]); setPrices([]); setDetail(null); setUnavailable(true); setSettings(result); setNotice('');
    const refreshed = await reload();
    setNotice(refreshed ? '成本设置已保存，历史成本已重新计算。' : '成本设置已保存。账本尚未刷新，请重试读取。');
  }
  function preferencesSaved(result: AccountingSettings) {
    setSettings(result);
    setNotice('偏好设置已保存。');
  }
  async function deleteEvent() {
    if (!pendingDelete || deleting) return; setDeleting(true);
    try { await api<boolean>('delete_event', { eventId: pendingDelete }); setPendingDelete(null); saved('交易已撤销。原始记录保留在数据库中，当前界面与导出不再展示。'); }
    catch (failure) { setError(String(failure)); } finally { setDeleting(false); }
  }
  const campaigns = (data?.campaigns ?? []).filter(campaign => (archive || campaign.status === 'active') && campaign.symbol.includes(symbol.trim().toUpperCase()));
  const leadDays = settings?.reminderLeadDays ?? 7;
  const reminders = reminderPositions(positions, leadDays);
  const overdueReminders = reminders.filter(position => position.daysLeft < 0).length;
  const pricedOptions = positions.filter(position => position.unrealizedPnl != null);
  const optionPnl = pricedOptions.reduce((total, position) => total + (position.unrealizedPnl ?? 0), 0);
  const optionCredit = pricedOptions.reduce((total, position) => total + position.avgCredit * position.multiplier * position.openQty, 0);
  const optionPnlPct = optionCredit > 0 ? optionPnl / optionCredit : null;
  const optionChainAt = positions.reduce<string | null>((latest, position) => {
    if (!position.chainFetchedAt) return latest;
    return !latest || position.chainFetchedAt > latest ? position.chainFetchedAt : latest;
  }, null);
  const asOf = data?.asOf ?? today();
  const title = page === 'detail' ? detail?.campaign.symbol ?? '战役详情' : page === 'reports' ? '报告' : page === 'settings' ? '设置' : page === 'entry' && editingId ? '修改交易' : navigationItems.find(item => item.id === page)?.label;
  return (
    <UpdateProvider>
      <ToastProvider position="bottom-right">
        <SidebarProvider>
          <AppSidebar
            navigation={navigation}
            page={page}
            onNavigate={id => navigate(id as Page)}
            reminderCount={reminders.length}
            overdueReminders={overdueReminders}
            desktop={desktop}
            accounts={activeAccounts}
            accountId={accountId}
            currentAccount={currentAccount}
            busy={busy}
            onSwitchAccount={switchAccount}
          />
          <SidebarInset>
            <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-background/85 px-3 backdrop-blur md:px-6">
              <SidebarTrigger />
              <Separator orientation="vertical" className="!h-5" />
              <div className="min-w-0 flex-1">
                <p className="num truncate text-xs text-muted-foreground">{asOf} · {currentAccount?.name ?? '默认账户'} · 美东交易日</p>
                <h1 className="truncate font-heading text-base leading-tight font-semibold">{title}</h1>
              </div>
              <div className="flex items-center gap-2">
                <Button aria-label="刷新账本" variant="outline" size="icon" disabled={busy || !desktop} onClick={() => void reload()}>
                  <RefreshCw className={busy ? 'animate-spin' : undefined} />
                </Button>
                {page !== 'entry' && (
                  <Button onClick={() => startEntry()}>
                    <Plus />
                    记一笔
                  </Button>
                )}
              </div>
            </header>
            <nav aria-label="主导航" className="flex gap-1 overflow-x-auto border-b bg-background/85 px-2 py-1.5 md:hidden">
              {navigation.flatMap(group => group.items).map(item => (
                <Button
                  key={item.id}
                  size="xs"
                  variant={page === item.id ? 'secondary' : 'ghost'}
                  className="shrink-0"
                  onClick={() => navigate(item.id as Page)}
                >
                  {item.label}
                </Button>
              ))}
              <Button size="xs" variant={page === 'settings' ? 'secondary' : 'ghost'} className="shrink-0" onClick={() => navigate('settings')}>设置</Button>
            </nav>
            <div className="flex flex-1 flex-col gap-6 p-3 md:p-6">
              {!desktop && (
                <Alert>
                  <AlertDescription>浏览器仅预览界面。请启动桌面应用使用本地 SQLite 账本。</AlertDescription>
                </Alert>
              )}
              <Updater />
              {error && (
                <Alert variant="error" className="alert error">
                  <AlertDescription className="flex flex-row flex-wrap items-center justify-between gap-3">
                    <span>{error}</span>
                    <Button size="xs" variant="outline" onClick={() => setError('')}>关闭</Button>
                  </AlertDescription>
                </Alert>
              )}
              {notice && (
                <Alert variant="success" role="status" className="alert success">
                  <AlertDescription>{notice}</AlertDescription>
                </Alert>
              )}
              {restoreStatus?.pending && (
                <Alert variant="error" className="alert error">
                  <AlertDescription>
                    已安排从 {restoreStatus.pending.backupFile} 恢复账本，将在下次启动时替换当前数据库。请完全退出并重新启动应用；在重启前账本只读。安全快照：{restoreStatus.pending.safetyFile}
                  </AlertDescription>
                </Alert>
              )}
              {restoreStatus?.lastResult && !restoreStatus.lastResult.ok && (
                <Alert variant="warning" role="status">
                  <AlertDescription>上次恢复失败：{restoreStatus.lastResult.message} 当前数据库未被替换。</AlertDescription>
                </Alert>
              )}
              {busy && !data && <p role="status" className="text-sm text-muted-foreground">正在读取本地账本…</p>}
              {unavailable && !busy && (
                <Alert variant="warning" role="status">
                  <AlertDescription className="flex flex-row flex-wrap items-center justify-between gap-3">
                    <span>账本尚未刷新，财务数据暂不可用。</span>
                    <Button size="xs" variant="outline" onClick={() => void reload()}>重试读取账本</Button>
                  </AlertDescription>
                </Alert>
              )}
              {['dashboard', 'positions', 'detail'].includes(page) && !!activeSymbols.length && (
                <p className="market-note -mt-2 text-xs text-muted-foreground">
                  {market.busy ? '正在更新标的参考价…' : market.error ? '行情更新失败，当前显示已保存的报价。' : '标的参考价使用已保存报价，可能延迟。'}
                  {' '}
                  <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={() => setPage('market')}>查看行情与报价时间</Button>
                </p>
              )}

              {page === 'overview' && !unavailable && (
                <>
                  {!desktop && <p className="text-sm text-muted-foreground">浏览器预览不读取本地账本，请在桌面应用查看账户总览。</p>}
                  {overviewError && (
                    <Alert variant="error">
                      <AlertDescription className="flex flex-row flex-wrap items-center justify-between gap-3">
                        <span>账户总览读取失败：{overviewError}</span>
                        <Button size="xs" variant="outline" onClick={() => void loadOverview()}>重试</Button>
                      </AlertDescription>
                    </Alert>
                  )}
                  {!overview && overviewBusy && <p role="status" className="text-sm text-muted-foreground">正在读取账户总览…</p>}
                  {overview && <AccountsOverview overview={overview} onOpenAccount={id => { if (id !== accountId) switchAccount(id); setPage('dashboard'); }} />}
                </>
              )}

              {page === 'holdings' && !unavailable && (
                <>
                  {!desktop && <p className="text-sm text-muted-foreground">浏览器预览不读取本地账本，请在桌面应用查看跨账户持仓。</p>}
                  {holdingsError && (
                    <Alert variant="error">
                      <AlertDescription className="flex flex-row flex-wrap items-center justify-between gap-3">
                        <span>跨账户持仓读取失败：{holdingsError}</span>
                        <Button size="xs" variant="outline" onClick={() => void loadHoldings()}>重试</Button>
                      </AlertDescription>
                    </Alert>
                  )}
                  {!holdings && holdingsBusy && <p role="status" className="text-sm text-muted-foreground">正在读取跨账户持仓…</p>}
                  {holdings && <AllHoldingsPage view={holdings} onOpenHolding={openHolding} onRefresh={loadHoldings} />}
                </>
              )}

              {page === 'dashboard' && !unavailable && (
                <>
                  <StatGrid>
                    <Stat label="已落袋净收租" value={money(data?.summary.premiumRealized ?? 0)} hint="已经了结的期权净收入" />
                    <Stat label="未平仓净权利金" value={money(data?.summary.premiumOpen ?? 0)} hint={`${data?.summary.openContracts ?? 0} 手合约仍待了结`} />
                    <Stat label="Put 资金义务" value={money(data?.summary.collateral ?? 0)} hint="按行权价计算" />
                    <Stat
                      label="进行中的战役"
                      value={<>{data?.summary.activeCampaigns ?? 0}<span className="ml-1 text-base font-normal text-muted-foreground">个</span></>}
                      hint={`持股共 ${data?.summary.sharesHeld ?? 0} 股`}
                    />
                  </StatGrid>
                  {data && <AccountCashPanel summary={data.summary} onEntry={kind => startEntry({ kind })} onReconcile={() => setReconcileOpen(true)} />}
                  <ReminderCard positions={positions} leadDays={leadDays} onOpenExpiry={() => setPage('expiry')} onOpenCalendar={() => setPage('calendar')} onOpenCampaign={openCampaign} />
                  <section className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h2 className="font-heading text-base font-semibold">
                        我的战役 <span className="count text-sm font-normal text-muted-foreground">{campaigns.length}</span>
                      </h2>
                      <div className="flex flex-wrap items-center gap-3">
                        <Input aria-label="筛选标的" placeholder="搜索标的…" className="w-56" value={symbol} onChange={e => setSymbol(e.target.value)} />
                        <label className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Checkbox checked={archive} onCheckedChange={value => setArchive(Boolean(value))} />
                          显示已结束
                        </label>
                      </div>
                    </div>
                    <div className="grid gap-3">
                      {campaigns.map(campaign => (
                        <CampaignCard key={campaign.id} campaign={campaign} quote={latestPrice(prices, campaign.symbol)} onOpen={() => openCampaign(campaign.id)} />
                      ))}
                    </div>
                    {!campaigns.length && (
                      <Empty className="rounded-2xl border border-dashed">
                        <EmptyHeader>
                          <EmptyMedia variant="icon"><Layers /></EmptyMedia>
                          <EmptyTitle>{data?.campaigns.length ? '没有符合条件的战役' : '从第一笔交易开始'}</EmptyTitle>
                          <EmptyDescription>记录一次卖 Put 或股票买入，自动追踪这一轮的成本和收租。</EmptyDescription>
                        </EmptyHeader>
                        <Button onClick={() => startEntry()}>记录第一笔交易</Button>
                      </Empty>
                    )}
                  </section>
                  <Footnote>
                    A 纯股票成本 · B 扣除已落袋净权利金 · C′ 再扣除未平仓净权利金。
                    {settings?.includeDividendsInCost ? '当前分红计入 B/C′ 成本。' : '当前分红不摊薄成本。'}
                  </Footnote>
                </>
              )}

              {page === 'ledger' && !unavailable && (
                <>
                  <ViewSwitch
                    label="台账分类"
                    value={ledgerTab}
                    onChange={setLedgerTab}
                    options={[{ value: 'entries', label: '收租明细' }, { value: 'events', label: '交易记录' }]}
                  />
                  {ledgerTab === 'entries'
                    ? <LedgerTable entries={ledger?.entries ?? []} openCampaign={openCampaign} />
                    : <EventLog events={events} onUndo={setPendingDelete} onEdit={editEvent} />}
                </>
              )}

              {page === 'cost' && !unavailable && (
                <CostReduction accountId={accountId} campaigns={data?.campaigns ?? []} positions={positions} initialCampaignId={scanCampaign} cashTracked={data?.summary.cashTracked ?? false} onEntry={prefill => startEntry(prefill)} />
              )}
              {page === 'entry' && (
                <EntryForm key={entryKey} initial={initial} initialRoll={initialRoll} initialNext={initialNext} eventId={editingId ?? undefined} onCancel={editingId ? cancelEdit : undefined} positions={positions} campaigns={data?.campaigns ?? []} includeDividendsInCost={settings?.includeDividendsInCost ?? false} accountId={accountId} onSaved={editingId ? editSaved : saved} onDone={target => { setPage(target); if (target === 'ledger') setLedgerTab('events'); }} />
              )}
              {page === 'import' && (
                <ImportWizard accountId={accountId} onCommitted={saved} onOpenVisionSettings={() => { setSettingsTab('vision'); setPage('settings'); }} />
              )}
              {page === 'expiry' && !unavailable && (
                <ExpiryCenter positions={positions} leadDays={leadDays} asOf={asOf} accountId={accountId} onEntry={initial => startEntry(initial)} onSettled={saved} onOpenCampaign={openCampaign} onOpenCalendar={() => setPage('calendar')} />
              )}
              {page === 'calendar' && !unavailable && (
                <ExpiryCalendar asOf={asOf} positions={positions} onOpenCampaign={openCampaign} />
              )}

              {page === 'reports' && !unavailable && (
                <>
                  <ViewSwitch
                    label="报告分类"
                    value={reportTab}
                    onChange={setReportTab}
                    options={[{ value: 'income', label: '收租月报' }, { value: 'annual', label: '年度报表' }, { value: 'compare', label: '战役对比' }]}
                  />
                  {reportTab === 'income' && <MonthlyIncomeReport report={income} />}
                  {reportTab === 'annual' && <AnnualReportPage report={annual} />}
                  {reportTab === 'compare' && <CampaignCompare campaigns={data?.campaigns ?? []} entries={ledger?.entries ?? []} asOf={asOf} />}
                </>
              )}

              {page === 'positions' && !unavailable && (
                <>
                  <section className="space-y-2">
                    <h2 className="font-heading text-base font-semibold">股票持仓</h2>
                    <div className="overflow-hidden rounded-xl border bg-card">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>标的</TableHead>
                            <TableHead className="text-right">股数</TableHead>
                            <TableHead className="text-right">纯股票成本 / 股</TableHead>
                            <TableHead className="text-right">有效成本 / 股</TableHead>
                            <TableHead className="text-right">标的参考价</TableHead>
                            <TableHead>操作</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data?.campaigns.filter(campaign => campaign.shares > 0).map(campaign => (
                            <TableRow key={campaign.id}>
                              <TableCell>
                                <Button variant="link" size="sm" className="h-auto p-0 font-medium" onClick={() => openCampaign(campaign.id)}>{campaign.symbol}</Button>
                              </TableCell>
                              <TableCell className="num text-right">{campaign.shares}</TableCell>
                              <TableCell className="num text-right">{money(campaign.costA)}</TableCell>
                              <TableCell className="num text-right">{money(campaign.costB)}</TableCell>
                              <TableCell className="num text-right">{money(campaign.price)}</TableCell>
                              <TableCell>
                                <Button variant="outline" size="xs" onClick={() => startEntry({ symbol: campaign.symbol, kind: 'shares_sell', qty: campaign.shares })}>卖出</Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {!data?.campaigns.some(campaign => campaign.shares > 0) && <p className="text-sm text-muted-foreground">暂无股票持仓。</p>}
                  </section>
                  <section className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="font-heading text-base font-semibold">未平仓期权</h2>
                      <span className="text-xs text-muted-foreground">按到期日排序</span>
                    </div>
                    <div className="option-pnl-summary flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-muted/30 px-4 py-3">
                      <div className="grid gap-0.5">
                        <span className="text-xs text-muted-foreground">期权浮动盈亏</span>
                        <strong className={`num text-lg font-semibold ${pnlTone(pricedOptions.length ? optionPnl : null)}`}>
                          {pricedOptions.length ? pnlLabel(optionPnl) : '—'}
                        </strong>
                      </div>
                      <div className="grid gap-0.5">
                        <span className="text-xs text-muted-foreground">收益率</span>
                        <strong className="num text-lg font-semibold">{percent(optionPnlPct)}</strong>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {pricedOptions.length}/{positions.length} 个合约有报价
                        {optionChainAt ? ` · 行情 ${chainTime(optionChainAt)}` : ' · 尚无期权链行情'}
                      </span>
                      <Button className="ms-auto" variant="outline" size="sm" disabled={optionQuotes.busy} onClick={() => void optionQuotes.refresh()}>
                        <RefreshCw className={optionQuotes.busy ? 'animate-spin' : ''} />
                        {optionQuotes.busy ? `更新中 ${optionQuotes.progress.done}/${optionQuotes.progress.total}` : '更新期权行情'}
                      </Button>
                    </div>
                    {optionQuotes.errors.length > 0 && (
                      <Alert variant="warning" role="status">
                        <AlertDescription>期权行情更新失败：{optionQuotes.errors.join('；')}</AlertDescription>
                      </Alert>
                    )}
                    <div className="overflow-hidden rounded-xl border bg-card">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>合约</TableHead>
                            <TableHead className="text-right">手数</TableHead>
                            <TableHead className="text-right">每股净权利金</TableHead>
                            <TableHead className="text-right">现价</TableHead>
                            <TableHead className="text-right">浮动盈亏</TableHead>
                            <TableHead className="text-right">盈亏率</TableHead>
                            <TableHead>到期 / 剩余</TableHead>
                            <TableHead>了结合约</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {positions.map(position => (
                            <TableRow key={position.contract}>
                              <TableCell>
                                <strong className="block font-medium">{position.contract}</strong>
                                <small className="block text-xs text-muted-foreground">{position.multiplier} 股/手</small>
                              </TableCell>
                              <TableCell className="num text-right">{position.openQty}</TableCell>
                              <TableCell className="num text-right">{money(position.avgCredit)}</TableCell>
                              <TableCell className="num text-right">
                                {money(position.mark)}
                                <small className="block text-xs text-muted-foreground">{chainStatusLabel[position.chainStatus] ?? position.chainStatus}</small>
                              </TableCell>
                              <TableCell className={`num text-right ${pnlTone(position.unrealizedPnl)}`}>
                                {pnlLabel(position.unrealizedPnl)}
                                {position.closeCost != null && <small className="block text-xs text-muted-foreground">平仓 {money(position.closeCost)}</small>}
                              </TableCell>
                              <TableCell className={`num text-right ${pnlTone(position.unrealizedPnl)}`}>
                                {percent(position.unrealizedPct)}
                                {position.collateralReturnPct != null && <small className="block text-xs text-muted-foreground">保证金 {percent(position.collateralReturnPct)}</small>}
                              </TableCell>
                              <TableCell>
                                <span className="block">{position.expiry}</span>
                                <small className={position.daysLeft < 0 ? 'text-destructive-foreground' : position.daysLeft <= 7 ? 'text-warning-foreground' : 'text-muted-foreground'}>
                                  {position.daysLeft < 0 ? `已过期 ${-position.daysLeft} 天` : `${position.daysLeft} 天`}
                                </small>
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-wrap gap-1.5">
                                  {['option_close', 'option_expire', 'option_assign'].map(kind => (
                                    <Button key={kind} variant="outline" size="xs" onClick={() => startEntry({ kind, date: kind === 'option_expire' ? position.expiry : today(), symbol: position.symbol, qty: position.openQty, expiry: position.expiry, strike: position.strike, right: position.right, multiplier: position.multiplier })}>
                                      {labels[kind]}
                                    </Button>
                                  ))}
                                  <Button variant="outline" size="xs" onClick={() => startEntry({ kind: 'option_close', date: today(), symbol: position.symbol, qty: position.openQty, expiry: position.expiry, strike: position.strike, right: position.right, multiplier: position.multiplier }, { roll: true })}>
                                    滚动
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {!positions.length && <p className="text-sm text-muted-foreground">暂无未平仓期权。</p>}
                  </section>
                </>
              )}

              {page === 'detail' && !unavailable && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Button variant="ghost" size="sm" onClick={() => setPage('dashboard')}><ArrowLeft />返回仪表盘</Button>
                    {detail && <Button onClick={() => openCostScan(detail.campaign.id)}>查看降本方案</Button>}
                  </div>
                  {detail ? (
                    <>
                      <CampaignCard campaign={detail.campaign} quote={latestPrice(prices, detail.campaign.symbol)} variant="panel" />
                      <CostChart points={detail.campaign.costPoints} prices={prices.filter(price => price.symbol === detail.campaign.symbol)} symbol={detail.campaign.symbol} callStrike={detail.positions.filter(position => position.right === 'C').sort((left, right) => left.expiry.localeCompare(right.expiry))[0]?.strike} />
                      <CallAssignmentScenarios scenarios={detail.callScenarios} />
                      <CampaignTimeline events={detail.events} onUndo={setPendingDelete} />
                      <LedgerTable entries={detail.entries} openCampaign={openCampaign} />
                      <section className="space-y-2">
                        <h2 className="font-heading text-base font-semibold">股票批次</h2>
                        <div className="overflow-hidden rounded-xl border bg-card">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>买入日期</TableHead>
                                <TableHead>初始股数</TableHead>
                                <TableHead>剩余股数</TableHead>
                                <TableHead>原始每股成本</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {detail.lots.map(lot => (
                                <TableRow key={lot.id}>
                                  <TableCell>{lot.openedAt}</TableCell>
                                  <TableCell className="num">{lot.qty}</TableCell>
                                  <TableCell className="num">{lot.remainingQty}</TableCell>
                                  <TableCell className="num">{money(lot.costPerShare)}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </section>
                    </>
                  ) : (
                    !error && <p role="status" className="text-sm text-muted-foreground">正在加载战役…</p>
                  )}
                </>
              )}

              {page === 'market' && (
                <MarketPage prices={prices} symbols={activeSymbols} market={market} onSaved={saved} onEntry={symbol => startEntry({ symbol })} />
              )}

              {page === 'settings' && (
                <>
                  <ViewSwitch
                    label="设置分类"
                    value={settingsTab}
                    onChange={setSettingsTab}
                    options={[
                      { value: 'accounting', label: '成本口径' },
                      { value: 'accounts', label: '账户' },
                      { value: 'reminders', label: '到期提醒' },
                      { value: 'vision', label: 'AI 识别' },
                      { value: 'data', label: '备份与维护' },
                      { value: 'about', label: '关于与更新' },
                    ]}
                  />
                  {settingsTab === 'accounting' && <AccountingPreferences settings={settings} onSaved={settingsSaved} />}
                  {settingsTab === 'accounts' && <AccountsPanel accounts={accounts} currentId={accountId} onSwitch={switchAccount} onAccounts={setAccounts} onNotice={setNotice} onError={setError} />}
                  {settingsTab === 'reminders' && <ReminderPreferences settings={settings} onSaved={preferencesSaved} />}
                  {settingsTab === 'vision' && <VisionSettings />}
                  {settingsTab === 'data' && <SettingsData accountId={accountId} info={info} events={events} campaigns={data?.campaigns ?? []} entries={ledger?.entries ?? []} positions={positions} settings={settings} restoreStatus={restoreStatus} onRestoreStatus={setRestoreStatus} onNotice={setNotice} onError={setError} onPreferencesSaved={preferencesSaved} />}
                  {settingsTab === 'about' && <AboutPanel version={info?.version ?? null} />}
                </>
              )}
            </div>
          </SidebarInset>
        </SidebarProvider>

        <AlertDialog open={!!pendingDelete} onOpenChange={open => { if (!open && !deleting) setPendingDelete(null); }}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>确认撤销这笔交易？</AlertDialogTitle>
              <AlertDialogDescription>
                这会重算持仓、成本和收租。如果后续交易依赖此记录，系统会拒绝撤销。原始记录不会被物理删除；撤销后不再出现在当前界面与导出中，但数据库仍保留审计行。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" disabled={deleting}>取消</Button>} />
              <Button variant="destructive" disabled={deleting} onClick={() => void deleteEvent()}>
                {deleting ? '正在撤销…' : '确认撤销'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
        {reconcileOpen && data && <ReconcileModal accountId={accountId} summary={data.summary} onClose={() => setReconcileOpen(false)} />}
      </ToastProvider>
    </UpdateProvider>
  );
}

function clamp(value: number, low: number, high: number) { return Math.max(low, Math.min(high, value)); }

/** Segmented view switcher. Buttons (not Tabs) so keyboard automation and
 * `aria-pressed` assertions keep working against the coss styles. */
function ViewSwitch<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex w-fit flex-wrap gap-0.5 rounded-lg border bg-muted/40 p-0.5">
      {options.map(option => (
        <Button
          key={option.value}
          size="sm"
          variant={option.value === value ? 'secondary' : 'ghost'}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function CostRuler({ campaign: c }: { campaign: Campaign }) {
  if (c.costB == null || c.price == null) return null;
  const values = [c.costB, c.price, ...(c.costA != null ? [c.costA] : [])];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(1, Math.abs(max) * .1);
  const pad = span * .12;
  const lo = min - pad;
  const hi = max + pad;
  const position = (value: number) => clamp(((value - lo) / (hi - lo)) * 100, 0, 100);
  const cost = position(c.costB);
  const price = position(c.price);
  const plain = c.costA != null ? position(c.costA) : null;
  const gain = c.price >= c.costB;
  const left = Math.min(cost, price);
  const width = Math.abs(price - cost);
  const labelsFit = width >= 10;
  return (
    <div className="relative mt-3 h-9 max-w-[520px]" role="img" aria-label={`成本线 ${money(c.costB)}，现价 ${money(c.price)}${c.safetyMargin != null ? `，距成本线 ${percent(c.safetyMargin)}` : ''}`}>
      <span className="absolute inset-x-0 top-2.5 h-0.5 rounded bg-muted" />
      <span className={`absolute top-2.5 h-0.5 rounded ${gain ? 'bg-success' : 'bg-destructive'}`} style={{ left: `${left}%`, width: `${width}%` }} />
      {plain != null && <span className="absolute top-1 h-3.5 w-px bg-muted-foreground/60" style={{ left: `${plain}%` }} />}
      <span className="absolute top-0.5 h-4.5 w-0.5 bg-foreground" style={{ left: `${cost}%` }} />
      <span className="absolute top-0.5 h-4.5 w-0.5 bg-info" style={{ left: `${price}%` }} />
      {labelsFit && <span className="absolute top-5 -translate-x-1/2 text-xs text-info-foreground" style={{ left: `${clamp(cost, 6, 94)}%` }}>成本</span>}
      <span className="absolute top-5 -translate-x-1/2 text-xs text-muted-foreground" style={{ left: `${clamp(price, 6, 94)}%` }}>现价</span>
    </div>
  );
}

function CampaignCard({ campaign: c, quote, onOpen, variant = 'row' }: { campaign: Campaign; quote?: Price; onOpen?: () => void; variant?: 'row' | 'panel' }) {
  return (
    <article className={`campaign-card rounded-2xl border bg-card p-4 shadow-xs/5 transition-colors${variant === 'panel' ? ' panel-card' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="symbol-title flex items-center gap-2">
            <h2 className="font-heading text-lg font-semibold">{c.symbol}</h2>
            <Badge variant={c.status === 'active' ? 'warning' : 'secondary'} size="sm">
              {c.status === 'active' ? '进行中' : '已结束'}
            </Badge>
          </div>
          <p className="campaign-meta mt-1 text-xs text-muted-foreground">
            {c.shares ? `持有 ${c.shares} 股` : c.status === 'closed' ? '战役已结算' : '建仓前收租'}
          </p>
        </div>
        <div className="campaign-price text-right">
          <span className="text-xs text-muted-foreground">标的参考价</span>
          <strong className="num block text-lg font-medium">{money(c.price)}</strong>
          <small className="block text-xs text-muted-foreground">
            {c.safetyMargin != null ? `距成本线 ${percent(c.safetyMargin)}` : '在行情页更新'}
          </small>
          <small className="block text-xs text-muted-foreground">{quoteTime(quote)}{quote?.quotedAt ? ' · 可能延迟' : ''}</small>
        </div>
      </div>

      <div className="campaign-cost mt-4">
        <div className="cost-focus">
          <span className="cost-label text-xs text-muted-foreground">
            {c.status === 'closed' ? '本轮总收益' : c.shares ? '已落袋有效成本 / 股' : '累计已落袋净收租'}
          </span>
          <strong className="num mt-0.5 block text-2xl font-semibold tracking-tight">
            {money(c.status === 'closed' ? c.realizedPnl : c.shares ? c.costB : c.premiumRealized)}
          </strong>
          {c.costB != null && c.costB <= 0 && <small className="text-xs text-success-foreground">成本已归零</small>}
        </div>
        {c.status !== 'closed' && <CostRuler campaign={c} />}
        {variant === 'row' && (
          <div className="cost-breakdown mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <div className="grid gap-0.5"><span className="text-xs text-muted-foreground">纯股票成本</span><strong className="num text-sm font-medium">{money(c.costA)}</strong></div>
            <div className="grid gap-0.5"><span className="text-xs text-muted-foreground">含未平仓成本</span><strong className="num text-sm font-medium">{money(c.costC)}</strong></div>
            <div className="grid gap-0.5"><span className="text-xs text-muted-foreground">已落袋权利金</span><strong className="num text-sm font-medium">{money(c.premiumRealized)}</strong></div>
            <div className="grid gap-0.5"><span className="text-xs text-muted-foreground">未平仓权利金</span><strong className="num text-sm font-medium">{money(c.premiumOpen)}</strong></div>
          </div>
        )}
      </div>

      <div className="card-bottom mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <span className="text-xs text-muted-foreground">
          {c.nextOption ? `${c.nextOption.openQty} 手 ${c.nextOption.strike}${c.nextOption.right} · ${c.nextOption.expiry} 到期` : `${c.startedAt} 开始 · ${c.cycles} 次了结`}
        </span>
        {onOpen && <Button variant="ghost" size="xs" onClick={onOpen}>查看战役<ChevronRight /></Button>}
      </div>
    </article>
  );
}
