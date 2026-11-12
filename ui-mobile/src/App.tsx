import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  bootstrap,
  hasTauri,
  overview,
  type Bootstrap,
  type Campaign,
  type EntryKind,
  type Lot,
  type Overview,
  type Position,
} from './api'
import EntrySheet from './EntrySheet'
import WebDavSheet from './WebDavSheet'

type Tab = 'home' | 'holdings' | 'expiry' | 'me'
type Theme = 'auto' | 'light' | 'dark'
type Segment = 'stocks' | 'options'
type ExpiryFilter = 'all' | 'overdue' | 'week' | 'month' | 'later'

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'home', label: '首页', icon: '◎' },
  { key: 'holdings', label: '持仓', icon: '▤' },
  { key: 'expiry', label: '到期', icon: '◷' },
  { key: 'me', label: '我的', icon: '☰' },
]

const FILTERS: { key: ExpiryFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'overdue', label: '已过期' },
  { key: 'week', label: '7 天内' },
  { key: 'month', label: '30 天内' },
  { key: 'later', label: '更远' },
]

function money(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const normalized = Object.is(value, -0) ? 0 : value
  return normalized.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function percent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

function dteLabel(days: number) {
  if (days < 0) return `已过期 ${-days} 天`
  if (days === 0) return '今天到期'
  return `${days} 天`
}

function rightLabel(right: string) {
  return right.toUpperCase() === 'P' ? 'PUT' : 'CALL'
}

function holdingsCost(campaigns: Campaign[], lot: Lot) {
  const campaign = campaigns.find((item) => item.symbol === lot.symbol)
  return campaign?.costB ?? lot.costPerShare
}

function statusLabel(status: string) {
  return status === 'active' ? '进行中' : status === 'closed' ? '已结束' : status
}

function campaignTone(campaign: Campaign) {
  if (campaign.status !== 'active') return 'muted'
  if ((campaign.safetyMargin ?? 0) < 0) return 'warn'
  return 'good'
}

function readTheme(): Theme {
  const stored = localStorage.getItem('wheel-theme')
  return stored === 'light' || stored === 'dark' ? stored : 'auto'
}

export default function App() {
  const [data, setData] = useState<Overview | null>(null)
  const [tab, setTab] = useState<Tab>('home')
  const [segment, setSegment] = useState<Segment>('stocks')
  const [filter, setFilter] = useState<ExpiryFilter>('all')
  const [sheet, setSheet] = useState<{ kind: EntryKind; position?: Position } | null>(null)
  const [webdavOpen, setWebdavOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')

  const load = useCallback(async () => {
    if (!hasTauri() && !import.meta.env.DEV) {
      setError('浏览器预览不读取账本，请在 Android 应用或 Tauri 桌面环境中打开。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const freshBoot: Bootstrap = await bootstrap()
      const fresh = await overview(freshBoot.accountId)
      setData(fresh)
    } catch (failure) {
      setError(String(failure))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'auto') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    localStorage.setItem('wheel-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2200)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  const positions = data?.positions ?? []
  const lots = data?.lots ?? []
  const campaigns = data?.campaigns ?? []

  const filtered = useMemo(() => {
    return positions.filter((position) => {
      if (filter === 'overdue') return position.daysLeft < 0
      if (filter === 'week') return position.daysLeft >= 0 && position.daysLeft <= 7
      if (filter === 'month') return position.daysLeft > 7 && position.daysLeft <= 30
      if (filter === 'later') return position.daysLeft > 30
      return true
    })
  }, [positions, filter])

  const counts = useMemo(
    () => ({
      all: positions.length,
      overdue: positions.filter((item) => item.daysLeft < 0).length,
      week: positions.filter((item) => item.daysLeft >= 0 && item.daysLeft <= 7).length,
      month: positions.filter((item) => item.daysLeft > 7 && item.daysLeft <= 30).length,
      later: positions.filter((item) => item.daysLeft > 30).length,
    }),
    [positions],
  )

  const handleSaved = (message: string) => {
    setSheet(null)
    setToast(message)
    void load()
  }

  return (
    <div className="app">
      <header className="app-head">
        <div className="brand">
          <p className="eyebrow">
            {data?.demo ? '演示账本' : '本机账本'} · {data?.asOf ?? '…'}
          </p>
          <h1>Wheel Tracker</h1>
        </div>
        <button
          className="icon-button"
          onClick={() => setTheme(theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto')}
          aria-label={`外观：${theme === 'auto' ? '跟随系统' : theme === 'dark' ? '深色' : '浅色'}`}
          title={`外观：${theme === 'auto' ? '跟随系统' : theme === 'dark' ? '深色' : '浅色'}`}
        >
          {theme === 'auto' ? '◐' : theme === 'dark' ? '☾' : '☀'}
        </button>
      </header>

      {error && (
        <div className="alert" role="alert">
          <strong>读取失败</strong>
          <span>{error}</span>
          <button className="link" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}

      {!data && !error && <div className="empty">正在读取本机账本…</div>}

      {data && (
        <main className="content">
          {tab === 'home' && (
            <Home data={data} onRefresh={() => void load()} busy={busy} onOpenSheet={setSheet} />
          )}
          {tab === 'holdings' && (
            <Holdings
              campaigns={campaigns}
              lots={lots}
              positions={positions}
              segment={segment}
              setSegment={setSegment}
              onOpenSheet={setSheet}
            />
          )}
          {tab === 'expiry' && (
            <Expiry
              filter={filter}
              setFilter={setFilter}
              counts={counts}
              positions={filtered}
              onOpenSheet={setSheet}
            />
          )}
          {tab === 'me' && (
            <Profile
              data={data}
              theme={theme}
              setTheme={setTheme}
              onReload={() => void load()}
              onOpenWebDav={() => setWebdavOpen(true)}
            />
          )}
        </main>
      )}

      {data && (
        <button
          className="fab"
          onClick={() => setSheet({ kind: 'option_open_short' })}
          aria-label="记一笔"
        >
          <span aria-hidden="true">+</span> 记一笔
        </button>
      )}

      <nav className="tabbar" aria-label="主导航">
        {TABS.map((item) => (
          <button
            key={item.key}
            className={tab === item.key ? 'on' : ''}
            onClick={() => setTab(item.key)}
            aria-current={tab === item.key ? 'page' : undefined}
          >
            <span aria-hidden="true">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      {sheet && data && (
        <EntrySheet
          today={data.asOf}
          accountId={data.accountId}
          preset={sheet}
          onClose={() => setSheet(null)}
          onSaved={handleSaved}
        />
      )}

      {webdavOpen && (
        <WebDavSheet
          onClose={() => setWebdavOpen(false)}
          onChanged={(message) => {
            setToast(message)
            void load()
          }}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}

function Home({
  data,
  busy,
  onRefresh,
  onOpenSheet,
}: {
  data: Overview
  busy: boolean
  onRefresh: () => void
  onOpenSheet: (sheet: { kind: EntryKind; position?: Position }) => void
}) {
  const { summary, campaigns, positions } = data
  const urgent = positions.filter((position) => position.daysLeft <= 3)
  return (
    <>
      <section className="hero">
        <div className="hero-top">
          <span>已落袋净收租</span>
          <button className="ghost" onClick={onRefresh} disabled={busy}>
            {busy ? '刷新中' : '刷新'}
          </button>
        </div>
        <p className="hero-value">{money(summary.premiumRealized)}</p>
        <div className="hero-grid">
          <div>
            <span>未平仓</span>
            <strong>{money(summary.premiumOpen)}</strong>
          </div>
          <div>
            <span>Put 义务</span>
            <strong>{money(summary.collateral, 0)}</strong>
          </div>
          <div>
            <span>现金覆盖</span>
            <strong>{summary.cashTracked ? percent(summary.cashCoverage) : '未跟踪'}</strong>
          </div>
        </div>
      </section>

      <div className="quick-row">
        <button onClick={() => onOpenSheet({ kind: 'option_open_short' })}>
          <span>＋</span>卖 Put
        </button>
        <button onClick={() => onOpenSheet({ kind: 'shares_buy' })}>
          <span>＄</span>买股票
        </button>
        <button onClick={() => onOpenSheet({ kind: 'cash_deposit' })}>
          <span>↓</span>入金
        </button>
      </div>

      {urgent.length > 0 && (
        <div className="notice" role="status">
          <strong>{urgent.length} 个合约需要处理</strong>
          <span>
            最近到期 {urgent[0].expiry} · {urgent[0].symbol}
          </span>
        </div>
      )}

      <section className="section">
        <div className="section-title">
          <h2>我的战役</h2>
          <span className="badge">{campaigns.length}</span>
        </div>
        {campaigns.length === 0 && <p className="empty">还没有战役，先记一笔卖出 Put。</p>}
        {campaigns.map((campaign) => (
          <article className="card campaign" key={campaign.id}>
            <div className="card-head">
              <div>
                <strong className="symbol">{campaign.symbol}</strong>
                <span className={`tag ${campaignTone(campaign)}`}>
                  {statusLabel(campaign.status)}
                </span>
              </div>
              <span className="muted">{campaign.shares} 股</span>
            </div>
            <div className="figure-row">
              <div>
                <span>成本 B</span>
                <strong>{money(campaign.costB)}</strong>
              </div>
              <div>
                <span>成本 A</span>
                <strong>{money(campaign.costA)}</strong>
              </div>
              <div>
                <span>成本 C′</span>
                <strong>{money(campaign.costC)}</strong>
              </div>
            </div>
            <div className="card-foot">
              <span>已落袋 {money(campaign.premiumRealized)}</span>
              <span>未平仓 {money(campaign.premiumOpen)}</span>
              {campaign.safetyMargin !== null && (
                <span className={campaign.safetyMargin < 0 ? 'negative' : 'positive'}>
                  安全边际 {percent(campaign.safetyMargin)}
                </span>
              )}
            </div>
            {campaign.nextOption && (
              <p className="next-option">
                下一张 {rightLabel(campaign.nextOption.right)} ${campaign.nextOption.strike}{' '}
                · {campaign.nextOption.expiry} · {dteLabel(campaign.nextOption.daysLeft)}
              </p>
            )}
          </article>
        ))}
      </section>
    </>
  )
}

function Holdings({
  campaigns,
  lots,
  positions,
  segment,
  setSegment,
  onOpenSheet,
}: {
  campaigns: Campaign[]
  lots: Lot[]
  positions: Position[]
  segment: Segment
  setSegment: (segment: Segment) => void
  onOpenSheet: (sheet: { kind: EntryKind; position?: Position }) => void
}) {
  return (
    <>
      <div className="segmented" role="group" aria-label="持仓分类">
        <button className={segment === 'stocks' ? 'on' : ''} onClick={() => setSegment('stocks')}>
          股票 {lots.length}
        </button>
        <button className={segment === 'options' ? 'on' : ''} onClick={() => setSegment('options')}>
          期权 {positions.length}
        </button>
      </div>

      {segment === 'stocks' && (
        <section className="section">
          {lots.length === 0 && <p className="empty">没有持股。</p>}
          {lots.map((lot) => (
            <article className="card" key={lot.id}>
              <div className="card-head">
                <strong className="symbol">{lot.symbol}</strong>
                <span className="badge">{lot.remainingQty} 股</span>
              </div>
              <div className="figure-row">
                <div>
                  <span>成本 / 股</span>
                  <strong>{money(holdingsCost(campaigns, lot))}</strong>
                </div>
                <div>
                  <span>买入价</span>
                  <strong>{money(lot.costPerShare)}</strong>
                </div>
                <div>
                  <span>建仓日</span>
                  <strong>{lot.openedAt}</strong>
                </div>
              </div>
            </article>
          ))}
        </section>
      )}

      {segment === 'options' && (
        <section className="section">
          {positions.length === 0 && <p className="empty">没有未平仓期权。</p>}
          {positions.map((position) => (
            <PositionCard
              key={position.contract + position.openedAt}
              position={position}
              onOpenSheet={onOpenSheet}
            />
          ))}
        </section>
      )}
    </>
  )
}

function Expiry({
  filter,
  setFilter,
  counts,
  positions,
  onOpenSheet,
}: {
  filter: ExpiryFilter
  setFilter: (filter: ExpiryFilter) => void
  counts: Record<ExpiryFilter, number>
  positions: Position[]
  onOpenSheet: (sheet: { kind: EntryKind; position?: Position }) => void
}) {
  return (
    <>
      <div className="chip-row scroll" role="group" aria-label="到期筛选">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            className={`chip ${filter === item.key ? 'on' : ''}`}
            onClick={() => setFilter(item.key)}
          >
            {item.label} {counts[item.key]}
          </button>
        ))}
      </div>
      <section className="section">
        {positions.length === 0 && <p className="empty">这个区间没有到期合约。</p>}
        {positions.map((position) => (
          <PositionCard
            key={position.contract + position.openedAt}
            position={position}
            onOpenSheet={onOpenSheet}
          />
        ))}
      </section>
    </>
  )
}

function PositionCard({
  position,
  onOpenSheet,
}: {
  position: Position
  onOpenSheet: (sheet: { kind: EntryKind; position?: Position }) => void
}) {
  const urgent = position.daysLeft <= 3
  return (
    <article className={`card position ${urgent ? 'urgent' : ''}`}>
      <div className="card-head">
        <div>
          <strong className="symbol">{position.symbol}</strong>
          <span className={`tag ${position.right.toUpperCase() === 'P' ? 'put' : 'call'}`}>
            {rightLabel(position.right)}
          </span>
        </div>
        <span className={`badge ${position.daysLeft < 0 ? 'negative' : ''}`}>
          {dteLabel(position.daysLeft)}
        </span>
      </div>
      <div className="figure-row">
        <div>
          <span>行权价</span>
          <strong>${money(position.strike, 1)}</strong>
        </div>
        <div>
          <span>到期</span>
          <strong>{position.expiry}</strong>
        </div>
        <div>
          <span>净权利金</span>
          <strong>{money(position.avgCredit * position.multiplier * position.openQty)}</strong>
        </div>
      </div>
      <div className="position-actions">
        <button onClick={() => onOpenSheet({ kind: 'option_close', position })}>平仓</button>
        <button onClick={() => onOpenSheet({ kind: 'option_expire', position })}>作废</button>
        <button onClick={() => onOpenSheet({ kind: 'option_assign', position })}>指派</button>
      </div>
    </article>
  )
}

function Profile({
  data,
  theme,
  setTheme,
  onReload,
  onOpenWebDav,
}: {
  data: Overview
  theme: Theme
  setTheme: (theme: Theme) => void
  onReload: () => void
  onOpenWebDav: () => void
}) {
  return (
    <>
      <section className="card account-card">
        <div className="card-head">
          <div>
            <span className="muted">当前账户</span>
            <strong className="symbol">{data.accounts[0]?.name ?? data.accountId}</strong>
          </div>
          <span className="badge">{data.accounts[0]?.eventCount ?? 0} 条事件</span>
        </div>
        <div className="figure-row">
          <div>
            <span>现金</span>
            <strong>{money(data.summary.accountCash)}</strong>
          </div>
          <div>
            <span>账户数</span>
            <strong>{data.accounts.length}</strong>
          </div>
          <div>
            <span>持股</span>
            <strong>{data.summary.sharesHeld}</strong>
          </div>
        </div>
      </section>

      <section className="section list">
        <h2>偏好</h2>
        <div className="list-row">
          <span>外观</span>
          <div className="segmented compact">
            {(['auto', 'light', 'dark'] as Theme[]).map((option) => (
              <button
                key={option}
                className={theme === option ? 'on' : ''}
                onClick={() => setTheme(option)}
              >
                {option === 'auto' ? '跟随' : option === 'light' ? '浅色' : '深色'}
              </button>
            ))}
          </div>
        </div>
        <div className="list-row">
          <span>数据</span>
          <button className="link" onClick={onReload}>
            重新读取
          </button>
        </div>
        <div className="list-row">
          <span>备份与同步</span>
          <button className="link" onClick={onOpenWebDav}>
            WebDAV
          </button>
        </div>
        <div className="list-row">
          <span>版本</span>
          <span className="muted">0.6.0 · M1/M2</span>
        </div>
      </section>

      <section className="section meta">
        <h2>本机数据库</h2>
        <p className="mono">{data.dbPath}</p>
        {data.demo && (
          <p className="note">
            当前是演示账本：首次启动写入的合成数据，不是你的真实交易。接入真实账本后会替换。
          </p>
        )}
      </section>
    </>
  )
}
