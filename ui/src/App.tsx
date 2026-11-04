import { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutDashboard, Layers, BookOpen, Plus, Settings, RefreshCw, ArrowLeft, ChevronRight, CircleDollarSign, Activity, Upload, CalendarDays, ChartScatter, TrendingUp } from 'lucide-react';
import { MarketPage, usePortfolioQuotes, latestPrice, quoteTime } from './MarketData';
import type { Account, AppInfo, Campaign, Dashboard, Detail, EventRow, Ledger, MonthlyIncome, NewEvent, Position, Price, RestoreStatus } from './types';
import { api, desktop, labels, money, percent, today } from './lib';
import { CostChart } from './CostChart';
import { LedgerTable } from './LedgerTable';
import { EntryForm } from './EntryForm';
import { AccountingPreferences, CampaignTimeline, CallAssignmentScenarios } from './CampaignInsights';
import type { AccountingSettings } from './types';
import { ImportWizard } from './ImportWizard';
import { ReminderCard, ReminderPreferences, reminderPositions } from './Reminders';
import { ExpiryCalendar } from './ExpiryCalendar';
import { CampaignCompare } from './CampaignCompare';
import { SettingsData } from './SettingsData';
import { AccountsPanel } from './Accounts';
import { MonthlyIncomeReport } from './MonthlyIncome';

const ACCOUNT_KEY = 'wheel.account';
type Page = 'dashboard' | 'positions' | 'ledger' | 'entry' | 'import' | 'calendar' | 'compare' | 'income' | 'market' | 'settings' | 'detail';
const navigation = [{ id: 'dashboard', label: '仪表盘', icon: LayoutDashboard }, { id: 'positions', label: '当前持仓', icon: Layers }, { id: 'ledger', label: '收租台账', icon: BookOpen }, { id: 'entry', label: '记一笔', icon: Plus }, { id: 'import', label: '导入', icon: Upload }, { id: 'calendar', label: '到期日历', icon: CalendarDays }, { id: 'compare', label: '战役对比', icon: ChartScatter }, { id: 'income', label: '收租月报', icon: TrendingUp }, { id: 'market', label: '行情', icon: Activity }, { id: 'settings', label: '设置', icon: Settings }] as const;

export default function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const [data, setData] = useState<Dashboard | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [income, setIncome] = useState<MonthlyIncome | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [prices, setPrices] = useState<Price[]>([]);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState(() => {
    try { return localStorage.getItem(ACCOUNT_KEY) ?? 'main'; } catch { return 'main'; }
  });
  const [settings, setSettings] = useState<AccountingSettings | null>(null);
  const [restoreStatus, setRestoreStatus] = useState<RestoreStatus | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [initial, setInitial] = useState<Partial<NewEvent>>();
  const [entryKey, setEntryKey] = useState(0);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false); const [archive, setArchive] = useState(false); const [symbol, setSymbol] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null); const [deleting, setDeleting] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const generation = useRef(0); const detailGeneration = useRef(0);
  const reload = useCallback(async () => {
    if (!desktop) return false;
    const current = ++generation.current; setBusy(true); setError('');
    try {
      const scope = { accountId };
      const [dashboard, book, options, history, report, quotes, preferences, metadata, restore] = await Promise.all([
        api<Dashboard>('dashboard', scope), api<Ledger>('ledger', scope), api<Position[]>('positions', scope), api<EventRow[]>('list_events', scope), api<MonthlyIncome>('monthly_income', scope), api<Price[]>('list_prices'), api<AccountingSettings>('get_settings'),
        api<AppInfo>('app_info').then(value => ({ value, error: '' }), failure => ({ value: null, error: String(failure) })),
        api<RestoreStatus>('restore_status').catch(() => null),
      ]);
      if (current !== generation.current) return false;
      setData(dashboard); setLedger(book); setIncome(report); setPositions(options.sort((a, b) => a.expiry.localeCompare(b.expiry))); setEvents(history); setPrices(quotes); setSettings(preferences); setUnavailable(false);
      setRestoreStatus(restore ?? { pending: null, lastResult: null, failed: [] });
      if (metadata.value) setInfo(metadata.value);
      else setError(`账本已更新，但应用信息读取失败：${metadata.error}`);
      return true;
    } catch (failure) {
      if (current === generation.current) {
        detailGeneration.current++;
        setData(null); setLedger(null); setIncome(null); setPositions([]); setEvents([]); setPrices([]); setDetail(null); setUnavailable(true); setError(String(failure));
      }
      return false;
    } finally { if (current === generation.current) setBusy(false); }
  }, [accountId]);
  const activeSymbols = [...new Set((data?.campaigns ?? []).filter(campaign => campaign.status === 'active').map(campaign => campaign.symbol))];
  const market = usePortfolioQuotes(activeSymbols, reload);
  const [settingsTab, setSettingsTab] = useState<'accounting' | 'accounts' | 'reminders' | 'data' | 'history'>('accounting');
  useEffect(() => { void reload(); return () => { generation.current++; }; }, [reload]);
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    api<Account[]>('list_accounts').then(list => {
      if (cancelled) return;
      setAccounts(list);
      if (list.length && !list.some(account => account.id === accountId)) {
        try { localStorage.setItem(ACCOUNT_KEY, list[0].id); } catch { /* storage unavailable in preview */ }
        setAccountId(list[0].id);
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
  const startEntry = useCallback((prefill?: Partial<NewEvent>) => { setInitial(prefill); setEntryKey(key => key + 1); setPage('entry'); }, []);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); startEntry(); } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [startEntry]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(timer); }, [notice]);
  function openCampaign(id: string) { setSelected(id); setPage('detail'); }
  function navigate(next: Page) { setPage(next); if (next === 'entry') startEntry(); }
  function switchAccount(id: string) {
    if (id === accountId) return;
    try { localStorage.setItem(ACCOUNT_KEY, id); } catch { /* storage unavailable in preview */ }
    setAccountId(id); setSelected(null); setDetail(null);
    if (page === 'detail') setPage('dashboard');
  }
  const currentAccount = accounts.find(account => account.id === accountId) ?? null;
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
    try { await api<boolean>('delete_event', { eventId: pendingDelete }); setPendingDelete(null); saved('交易已撤销，原始记录保留在审计日志中。'); }
    catch (failure) { setError(String(failure)); } finally { setDeleting(false); }
  }
  const campaigns = (data?.campaigns ?? []).filter(campaign => (archive || campaign.status === 'active') && campaign.symbol.includes(symbol.trim().toUpperCase()));
  const leadDays = settings?.reminderLeadDays ?? 7;
  const reminders = reminderPositions(positions, leadDays);
  const overdueReminders = reminders.filter(position => position.daysLeft < 0).length;
  const asOf = data?.asOf ?? today();
  const title = page === 'detail' ? detail?.campaign.symbol ?? '战役详情' : navigation.find(item => item.id === page)?.label;
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><CircleDollarSign size={30}/><div>Wheel Tracker<small>车轮策略成本账本</small></div></div><nav aria-label="主导航">{navigation.map(item => <button key={item.id} aria-current={page === item.id ? 'page' : undefined} className={page === item.id ? 'selected' : ''} title={item.id === 'positions' && reminders.length ? `${reminders.length} 个到期提醒` : undefined} onClick={() => navigate(item.id)}><item.icon size={18}/>{item.label}{item.id === 'entry' && <kbd>Ctrl N</kbd>}{item.id === 'positions' && reminders.length > 0 && <span className={`nav-badge ${overdueReminders ? 'danger' : ''}`} aria-hidden="true">{reminders.length}</span>}</button>)}</nav><div className="sidebar-bottom"><span className="connection-dot"/>{desktop ? '本地账本' : '浏览器预览'}<label className="account-switch"><span>账户</span><select aria-label="切换账户" disabled={!desktop || busy || !accounts.length} value={accountId} onChange={event => switchAccount(event.target.value)}>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}{!accounts.length && <option value={accountId}>默认账户</option>}</select></label><small>{currentAccount?.currency ?? 'USD'} · {accounts.length ? `共 ${accounts.length} 个账户` : '美元 USD'}</small></div></aside>
    <main><header className="page-heading"><div><p className="muted">{asOf} · {currentAccount?.name ?? '默认账户'} · UTC</p><h1>{title}</h1></div><div className="toolbar"><button aria-label="刷新账本" disabled={busy || !desktop} onClick={() => void reload()}><RefreshCw size={16} className={busy ? 'spinning' : ''}/></button><button className="primary" onClick={() => startEntry()}><Plus size={17}/>记一笔</button></div></header>
    {!desktop && <div className="alert">浏览器仅预览界面。请启动桌面应用使用本地 SQLite 账本。</div>}
    {error && <div className="alert error" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}
    {notice && <div className="alert success" role="status">{notice}</div>}
    {restoreStatus?.pending && <div className="alert error" role="alert">已安排从 {restoreStatus.pending.backupFile} 恢复账本，将在下次启动时替换当前数据库。请完全退出并重新启动应用；在重启前账本只读。安全快照：{restoreStatus.pending.safetyFile}</div>}
    {restoreStatus?.lastResult && !restoreStatus.lastResult.ok && <div className="alert warning" role="status">上次恢复失败：{restoreStatus.lastResult.message} 当前数据库未被替换。</div>}
    {busy && !data && <p role="status">正在读取本地账本…</p>}
    {unavailable && !busy && <div className="alert warning" role="status">账本尚未刷新，财务数据暂不可用。<button onClick={() => void reload()}>重试读取账本</button></div>}
    {['dashboard', 'positions', 'detail'].includes(page) && !!activeSymbols.length && <p className="market-note">{market.busy ? '正在更新标的参考价…' : market.error ? '行情更新失败，当前显示已保存的报价。' : '标的参考价使用已保存报价，可能延迟。'} <button className="text-button" onClick={() => setPage('market')}>查看行情与报价时间</button></p>}
    {page === 'dashboard' && !unavailable && <>
      <div className="summary-strip"><div><span>已落袋净收租</span><strong>{money(data?.summary.premiumRealized ?? 0)}</strong><small>已经了结的期权净收入</small></div><div><span>未平仓净权利金</span><strong>{money(data?.summary.premiumOpen ?? 0)}</strong><small>{data?.summary.openContracts ?? 0} 手合约仍待了结</small></div><div><span>Put 资金义务</span><strong>{money(data?.summary.collateral ?? 0)}</strong><small>按行权价计算</small></div><div><span>进行中的战役</span><strong>{data?.summary.activeCampaigns ?? 0}<em> 个</em></strong><small>持股共 {data?.summary.sharesHeld ?? 0} 股</small></div></div>
      <ReminderCard positions={positions} leadDays={leadDays} onOpenPositions={() => setPage('positions')} onOpenCalendar={() => setPage('calendar')} onOpenCampaign={openCampaign}/>
      <div className="section-heading"><h2>我的战役 <span className="count">{campaigns.length}</span></h2><div className="toolbar"><input aria-label="筛选标的" placeholder="搜索标的…" value={symbol} onChange={e => setSymbol(e.target.value)}/><label className="check"><input type="checkbox" checked={archive} onChange={e => setArchive(e.target.checked)}/>显示已结束</label></div></div>
      <div className="campaign-grid">{campaigns.map(campaign => <CampaignCard key={campaign.id} campaign={campaign} quote={latestPrice(prices, campaign.symbol)} onOpen={() => openCampaign(campaign.id)}/>)}</div>
      {!campaigns.length && <div className="empty panel"><Layers size={36}/><h2>{data?.campaigns.length ? '没有符合条件的战役' : '从第一笔交易开始'}</h2><p>记录一次卖 Put 或股票买入，自动追踪这一轮的成本和收租。</p><button className="primary" onClick={() => startEntry()}>记录第一笔交易</button></div>}
      <p className="footnote">A 纯股票成本 · B 扣除已落袋净权利金 · C′ 再扣除未平仓净权利金。{settings?.includeDividendsInCost ? '当前分红计入 B/C′ 成本。' : '当前分红不摊薄成本。'}</p>
    </>}
    {page === 'ledger' && !unavailable && <LedgerTable entries={ledger?.entries ?? []} openCampaign={openCampaign}/>}
    {page === 'entry' && <EntryForm key={entryKey} initial={initial} positions={positions} accountId={accountId} onSaved={saved}/>}
    {page === 'import' && <ImportWizard accountId={accountId} onCommitted={saved}/>}
    {page === 'calendar' && !unavailable && <ExpiryCalendar asOf={asOf} positions={positions} onOpenCampaign={openCampaign}/>}
    {page === 'compare' && !unavailable && <CampaignCompare campaigns={data?.campaigns ?? []} entries={ledger?.entries ?? []} asOf={asOf}/>}
    {page === 'income' && !unavailable && <MonthlyIncomeReport report={income}/>}
    {page === 'positions' && !unavailable && <>
      <section className="panel"><div className="section-heading"><h2>股票持仓</h2></div><div className="table-wrap"><table><thead><tr><th>标的</th><th>股数</th><th>纯股票成本 / 股</th><th>有效成本 / 股</th><th>标的参考价</th><th>操作</th></tr></thead><tbody>{data?.campaigns.filter(campaign => campaign.shares > 0).map(campaign => <tr key={campaign.id}><td><button className="text-button" onClick={() => openCampaign(campaign.id)}>{campaign.symbol}</button></td><td>{campaign.shares}</td><td>{money(campaign.costA)}</td><td>{money(campaign.costB)}</td><td>{money(campaign.price)}</td><td><button onClick={() => startEntry({ symbol: campaign.symbol, kind: 'shares_sell', qty: campaign.shares })}>卖出</button></td></tr>)}</tbody></table></div>{!data?.campaigns.some(campaign => campaign.shares > 0) && <p className="empty">暂无股票持仓。</p>}</section>
      <section className="panel"><div className="section-heading"><h2>未平仓期权</h2><span className="muted">按到期日排序</span></div><div className="table-wrap"><table><thead><tr><th>合约</th><th>手数</th><th>每股净权利金</th><th>到期日</th><th>剩余天数</th><th>了结合约</th></tr></thead><tbody>{positions.map(position => <tr key={position.contract}><td>{position.contract}</td><td>{position.openQty}</td><td>{money(position.avgCredit)}</td><td>{position.expiry}</td><td><span className={position.daysLeft < 0 ? 'negative' : position.daysLeft <= 7 ? 'warning-text' : ''}>{position.daysLeft < 0 ? `已过期 ${-position.daysLeft} 天` : `${position.daysLeft} 天`}</span></td><td><div className="toolbar">{['option_close', 'option_expire', 'option_assign'].map(kind => <button key={kind} onClick={() => startEntry({ kind, date: kind === 'option_expire' ? position.expiry : today(), symbol: position.symbol, qty: position.openQty, expiry: position.expiry, strike: position.strike, right: position.right })}>{labels[kind]}</button>)}</div></td></tr>)}</tbody></table></div>{!positions.length && <p className="empty">暂无未平仓期权。</p>}</section>
    </>}
    {page === 'detail' && !unavailable && <><button className="back-button" onClick={() => setPage('dashboard')}><ArrowLeft size={16}/>返回仪表盘</button>{detail ? <><CampaignCard campaign={detail.campaign} quote={latestPrice(prices, detail.campaign.symbol)}/><p className="footnote">{settings?.includeDividendsInCost ? '当前 B/C′ 成本已扣除累计分红。' : '当前分红不摊薄 B/C′ 成本，可在设置页调整。'}</p><CostChart points={detail.campaign.costPoints} prices={prices.filter(price => price.symbol === detail.campaign.symbol)} symbol={detail.campaign.symbol} callStrike={detail.positions.filter(position => position.right === 'C').sort((left, right) => left.expiry.localeCompare(right.expiry))[0]?.strike}/><CallAssignmentScenarios scenarios={detail.callScenarios}/><CampaignTimeline events={detail.events}/><LedgerTable entries={detail.entries} openCampaign={openCampaign}/><section className="panel"><div className="section-heading"><h2>股票批次</h2></div><div className="table-wrap"><table><thead><tr><th>买入日期</th><th>初始股数</th><th>剩余股数</th><th>原始每股成本</th></tr></thead><tbody>{detail.lots.map(lot => <tr key={lot.id}><td>{lot.openedAt}</td><td>{lot.qty}</td><td>{lot.remainingQty}</td><td>{money(lot.costPerShare)}</td></tr>)}</tbody></table></div></section></> : !error && <p role="status">正在加载战役…</p>}</>}
    {page === 'market' && <MarketPage prices={prices} symbols={activeSymbols} market={market} onSaved={saved} onEntry={symbol => startEntry({ symbol })}/>}
    {page === 'settings' && <>
      <div className="settings-tabs" aria-label="设置分类">{(['accounting', 'accounts', 'reminders', 'data', 'history'] as const).map(tab => <button key={tab} aria-pressed={settingsTab === tab} onClick={() => setSettingsTab(tab)}>{{ accounting: '成本口径', accounts: '账户', reminders: '到期提醒', data: '备份与维护', history: '交易记录' }[tab]}</button>)}</div>
      {settingsTab === 'accounting' && <AccountingPreferences settings={settings} onSaved={settingsSaved}/>}
      {settingsTab === 'accounts' && <AccountsPanel accounts={accounts} currentId={accountId} onSwitch={switchAccount} onAccounts={setAccounts} onNotice={setNotice} onError={setError}/>}
      {settingsTab === 'reminders' && <ReminderPreferences settings={settings} onSaved={preferencesSaved}/>}
      {settingsTab === 'data' && <SettingsData accountId={accountId} info={info} events={events} campaigns={data?.campaigns ?? []} entries={ledger?.entries ?? []} positions={positions} settings={settings} restoreStatus={restoreStatus} onRestoreStatus={setRestoreStatus} onNotice={setNotice} onError={setError} onPreferencesSaved={preferencesSaved}/>}
      {settingsTab === 'history' && <section className="panel"><div className="section-heading"><h2>交易事件日志</h2><span className="muted">撤销前会重新校验后续交易</span></div><div className="table-wrap"><table><thead><tr><th>日期</th><th>类型</th><th>标的 / 合约</th><th>数量</th><th>每股价格</th><th>费用</th><th>备注</th><th>操作</th></tr></thead><tbody>{[...events].reverse().map(event => <tr key={event.id}><td>{event.date}</td><td>{labels[event.kind]}</td><td>{event.symbol} {event.expiry} {event.strike}{event.right}</td><td>{event.qty}</td><td>{money(event.price)}</td><td>{money(event.fees)}</td><td className="note-cell">{event.note}</td><td><button onClick={() => setPendingDelete(event.id)}>撤销</button></td></tr>)}</tbody></table></div>{!events.length && <p className="empty">暂无交易记录。</p>}</section>}
    </>}
    {pendingDelete && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="delete-title" className="modal"><h2 id="delete-title">确认撤销这笔交易？</h2><p>这会重算持仓、成本和收租。如果后续交易依赖此记录，系统会拒绝撤销。原始数据将保留用于审计。</p><div className="toolbar"><button autoFocus disabled={deleting} onClick={() => setPendingDelete(null)}>取消</button><button className="danger" disabled={deleting} onClick={() => void deleteEvent()}>{deleting ? '正在撤销…' : '确认撤销'}</button></div></section></div>}
    </main></div>;
}

function CampaignCard({ campaign: c, quote, onOpen }: { campaign: Campaign; quote?: Price; onOpen?: () => void }) {
  return <article className="campaign-card"><div className="section-heading"><div className="symbol-title"><h2>{c.symbol}</h2><span className={`badge ${c.status}`}>{c.status === 'active' ? '进行中' : '已结束'}</span></div><span className="muted">{c.shares ? `持有 ${c.shares} 股` : c.status === 'closed' ? '战役已结算' : '建仓前收租'}</span></div><div className="cost-focus"><div><span>{c.status === 'closed' ? '本轮总收益' : c.shares ? '已落袋有效成本 / 股' : '累计已落袋净收租'}</span><strong>{money(c.status === 'closed' ? c.realizedPnl : c.shares ? c.costB : c.premiumRealized)}</strong>{c.costB != null && c.costB <= 0 && <small className="positive">成本已归零</small>}</div><div className="price-block"><span>标的参考价</span><strong>{money(c.price)}</strong><small>{c.safetyMargin != null ? `距成本线 ${percent(c.safetyMargin)}` : '在行情页更新'}</small><small>{quoteTime(quote)}{quote?.quotedAt ? ' · 可能延迟' : ''}</small></div></div><div className="cost-breakdown"><span>纯股票成本<strong>{money(c.costA)}</strong></span><span>含未平仓成本<strong>{money(c.costC)}</strong></span><span>已落袋权利金<strong>{money(c.premiumRealized)}</strong></span><span>未平仓权利金<strong>{money(c.premiumOpen)}</strong></span></div><div className="card-bottom"><span>{c.nextOption ? `${c.nextOption.openQty} 手 ${c.nextOption.strike}${c.nextOption.right} · ${c.nextOption.expiry} 到期` : `${c.startedAt} 开始 · ${c.cycles} 次了结`}</span>{onOpen && <button className="text-button" onClick={onOpen}>查看战役<ChevronRight size={16}/></button>}</div></article>;
}

