import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  BanknoteIcon,
  ClockIcon,
  HomeIcon,
  LayersIcon,
  MoonIcon,
  PlusIcon,
  RefreshCwIcon,
  SunIcon,
  SunMoonIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  UserIcon,
  type LucideIcon,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { cn } from '@/lib/utils'
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

const TABS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: 'home', label: '首页', icon: HomeIcon },
  { key: 'holdings', label: '持仓', icon: LayersIcon },
  { key: 'expiry', label: '到期', icon: ClockIcon },
  { key: 'me', label: '我的', icon: UserIcon },
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

function readTheme(): Theme {
  const stored = localStorage.getItem('wheel-theme')
  return stored === 'light' || stored === 'dark' ? stored : 'auto'
}

function themeLabel(theme: Theme) {
  return theme === 'auto' ? '跟随系统' : theme === 'dark' ? '深色' : '浅色'
}

function Figure({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[11px] leading-tight text-muted-foreground">{label}</span>
      <strong className={cn('num truncate text-sm font-medium', className)}>{value}</strong>
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  label: string
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('inline-flex w-full rounded-lg border bg-muted/40 p-0.5', className)}
    >
      {options.map((option) => (
        <Button
          key={option.value}
          size="sm"
          variant={option.value === value ? 'secondary' : 'ghost'}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className="flex-1"
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

function ChipValue({ children }: { children: ReactNode }) {
  return <span className="num text-[10px] leading-none opacity-70">{children}</span>
}

function CampaignBadge({ campaign }: { campaign: Campaign }) {
  if (campaign.status !== 'active') {
    return (
      <Badge variant="secondary" size="sm">
        {statusLabel(campaign.status)}
      </Badge>
    )
  }
  if ((campaign.safetyMargin ?? 0) < 0) {
    return (
      <Badge variant="warning" size="sm">
        进行中
      </Badge>
    )
  }
  return (
    <Badge variant="success" size="sm">
      进行中
    </Badge>
  )
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
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'auto' && media.matches)
      root.classList.toggle('dark', dark)
      if (theme === 'auto') root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', theme)
    }
    apply()
    media.addEventListener('change', apply)
    localStorage.setItem('wheel-theme', theme)
    return () => media.removeEventListener('change', apply)
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

  const ThemeIcon = theme === 'auto' ? SunMoonIcon : theme === 'dark' ? MoonIcon : SunIcon

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[30rem] flex-col gap-5 px-4 pb-[calc(6.5rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))]">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {data?.demo ? '演示账本' : '本机账本'} · {data?.asOf ?? '…'}
          </p>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Wheel Tracker</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-9"
            onClick={() =>
              setTheme(theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto')
            }
            aria-label={`外观：${themeLabel(theme)}`}
            title={`外观：${themeLabel(theme)}`}
          >
            <ThemeIcon className="size-4" />
          </Button>
          {data && (
            <Button size="default" onClick={() => setSheet({ kind: 'option_open_short' })}>
              <PlusIcon />
              记一笔
            </Button>
          )}
        </div>
      </header>

      {error && (
        <Alert variant="error" role="alert" className="grid-cols-[1fr_auto]">
          <AlertTitle>读取失败</AlertTitle>
          <AlertDescription className="text-xs text-muted-foreground">{error}</AlertDescription>
          <Button
            variant="outline"
            size="xs"
            className="col-start-2 row-start-1 self-center"
            onClick={() => void load()}
          >
            重试
          </Button>
        </Alert>
      )}

      {!data && !error && (
        <p className="py-16 text-center text-sm text-muted-foreground">正在读取本机账本…</p>
      )}

      {data && (
        <main className="flex flex-col gap-5">
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

      <nav
        aria-label="主导航"
        className="fixed inset-x-0 bottom-0 z-30 mx-auto grid w-full max-w-[30rem] grid-cols-4 border-t bg-background/95 px-2 pb-[calc(0.375rem+env(safe-area-inset-bottom))] pt-1.5 backdrop-blur"
      >
        {TABS.map((item) => {
          const Icon = item.icon
          const active = tab === item.key
          return (
            <Button
              key={item.key}
              variant="ghost"
              onClick={() => setTab(item.key)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'h-auto flex-col gap-1 rounded-lg py-1.5 text-[11px] font-normal',
                active ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              <Icon className={cn('size-5', active ? 'opacity-100' : 'opacity-70')} />
              {item.label}
            </Button>
          )
        })}
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
        <div
          className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-1/2 z-50 -translate-x-1/2 animate-in rounded-lg bg-foreground px-3.5 py-2 text-xs text-background shadow-lg duration-200 fade-in-0 slide-in-from-bottom-2"
          role="status"
        >
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
      <Card>
        <CardHeader className="gap-2 p-4 pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardDescription className="text-xs">已落袋净收租</CardDescription>
            <Button variant="ghost" size="xs" onClick={onRefresh} disabled={busy}>
              <RefreshCwIcon className={busy ? 'animate-spin' : undefined} />
              {busy ? '刷新中' : '刷新'}
            </Button>
          </div>
          <p className="num text-3xl font-semibold tracking-tight">{money(summary.premiumRealized)}</p>
        </CardHeader>
        <CardPanel className="p-4 pt-0">
          <div className="grid grid-cols-3 gap-2 border-t pt-3">
            <Figure label="未平仓" value={money(summary.premiumOpen)} />
            <Figure label="Put 义务" value={money(summary.collateral)} />
            <Figure
              label="现金覆盖"
              value={summary.cashTracked ? percent(summary.cashCoverage) : '未跟踪'}
            />
          </div>
        </CardPanel>
      </Card>

      <div className="grid grid-cols-3 gap-2">
        <Button
          variant="outline"
          className="h-auto flex-col gap-1.5 rounded-xl py-3 text-xs font-normal"
          onClick={() => onOpenSheet({ kind: 'option_open_short' })}
        >
          <TrendingDownIcon />
          卖 Put
        </Button>
        <Button
          variant="outline"
          className="h-auto flex-col gap-1.5 rounded-xl py-3 text-xs font-normal"
          onClick={() => onOpenSheet({ kind: 'shares_buy' })}
        >
          <TrendingUpIcon />
          买股票
        </Button>
        <Button
          variant="outline"
          className="h-auto flex-col gap-1.5 rounded-xl py-3 text-xs font-normal"
          onClick={() => onOpenSheet({ kind: 'cash_deposit' })}
        >
          <BanknoteIcon />
          入金
        </Button>
      </div>

      {urgent.length > 0 && (
        <Alert variant="warning" role="status">
          <AlertTitle>{urgent.length} 个合约需要处理</AlertTitle>
          <AlertDescription className="text-xs">
            最近到期 {urgent[0].expiry} · {urgent[0].symbol}
          </AlertDescription>
        </Alert>
      )}

      <section className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between px-1">
          <h2 className="font-heading text-sm font-semibold">我的战役</h2>
          <Badge variant="secondary" size="sm">
            {campaigns.length}
          </Badge>
        </div>
        {campaigns.length === 0 && (
          <Empty className="rounded-2xl border border-dashed py-10">
            <EmptyHeader>
              <EmptyTitle className="text-base">还没有战役</EmptyTitle>
              <EmptyDescription>先记一笔卖出 Put 开始。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {campaigns.length > 0 && (
          <div className="flex flex-col gap-2.5">
            {campaigns.map((campaign) => (
              <Card key={campaign.id}>
                <CardHeader className="gap-1 p-4 pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <CardTitle className="truncate text-base">{campaign.symbol}</CardTitle>
                      <CampaignBadge campaign={campaign} />
                    </div>
                    <span className="num shrink-0 text-xs text-muted-foreground">
                      {campaign.shares} 股
                    </span>
                  </div>
                </CardHeader>
                <CardPanel className="p-4 pt-0">
                  <div className="grid grid-cols-3 gap-2 border-t pt-3">
                    <Figure label="成本 B" value={money(campaign.costB)} />
                    <Figure label="成本 A" value={money(campaign.costA)} />
                    <Figure label="成本 C′" value={money(campaign.costC)} />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>已落袋 {money(campaign.premiumRealized)}</span>
                    <span>未平仓 {money(campaign.premiumOpen)}</span>
                    {campaign.safetyMargin !== null && (
                      <span
                        className={cn(
                          'num',
                          campaign.safetyMargin < 0
                            ? 'text-destructive-foreground'
                            : 'text-success-foreground',
                        )}
                      >
                        安全边际 {percent(campaign.safetyMargin)}
                      </span>
                    )}
                  </div>
                  {campaign.nextOption && (
                    <p className="mt-3 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                      下一张 {rightLabel(campaign.nextOption.right)} ${campaign.nextOption.strike} ·{' '}
                      {campaign.nextOption.expiry} · {dteLabel(campaign.nextOption.daysLeft)}
                    </p>
                  )}
                </CardPanel>
              </Card>
            ))}
          </div>
        )}
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
      <Segmented
        label="持仓分类"
        value={segment}
        onChange={setSegment}
        options={[
          { value: 'stocks', label: `股票 ${lots.length}` },
          { value: 'options', label: `期权 ${positions.length}` },
        ]}
      />

      {segment === 'stocks' && (
        <section className="flex flex-col gap-2.5">
          {lots.length === 0 && (
            <Empty className="rounded-2xl border border-dashed py-10">
              <EmptyHeader>
                <EmptyTitle className="text-base">没有持股</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
          {lots.map((lot) => (
            <Card key={lot.id}>
              <CardHeader className="gap-1 p-4 pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="truncate text-base">{lot.symbol}</CardTitle>
                  <span className="num shrink-0 text-xs text-muted-foreground">
                    {lot.remainingQty} 股
                  </span>
                </div>
              </CardHeader>
              <CardPanel className="p-4 pt-0">
                <div className="grid grid-cols-3 gap-2 border-t pt-3">
                  <Figure label="成本 / 股" value={money(holdingsCost(campaigns, lot))} />
                  <Figure label="买入价" value={money(lot.costPerShare)} />
                  <Figure label="建仓日" value={lot.openedAt} />
                </div>
              </CardPanel>
            </Card>
          ))}
        </section>
      )}

      {segment === 'options' && (
        <section className="flex flex-col gap-2.5">
          {positions.length === 0 && (
            <Empty className="rounded-2xl border border-dashed py-10">
              <EmptyHeader>
                <EmptyTitle className="text-base">没有未平仓期权</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
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
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="到期筛选">
        {FILTERS.map((item) => (
          <Button
            key={item.key}
            size="sm"
            variant={filter === item.key ? 'secondary' : 'outline'}
            aria-pressed={filter === item.key}
            onClick={() => setFilter(item.key)}
            className="rounded-full"
          >
            {item.label}
            <ChipValue>{counts[item.key]}</ChipValue>
          </Button>
        ))}
      </div>
      <section className="flex flex-col gap-2.5">
        {positions.length === 0 && (
          <Empty className="rounded-2xl border border-dashed py-10">
            <EmptyHeader>
              <EmptyTitle className="text-base">这个区间没有到期合约</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
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
    <Card>
      <CardHeader className="gap-1 p-4 pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <CardTitle className="truncate text-base">{position.symbol}</CardTitle>
            <Badge variant="outline" size="sm">
              {rightLabel(position.right)}
            </Badge>
          </div>
          <span
            className={cn(
              'num shrink-0 text-xs',
              position.daysLeft < 0
                ? 'text-destructive-foreground'
                : urgent
                  ? 'text-warning-foreground'
                  : 'text-muted-foreground',
            )}
          >
            {dteLabel(position.daysLeft)}
          </span>
        </div>
      </CardHeader>
      <CardPanel className="p-4 pt-0">
        <div className="grid grid-cols-3 gap-2 border-t pt-3">
          <Figure label="行权价" value={`$${money(position.strike, 1)}`} />
          <Figure label="到期" value={position.expiry} />
          <Figure
            label="净权利金"
            value={money(position.avgCredit * position.multiplier * position.openQty)}
          />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 border-t pt-3">
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => onOpenSheet({ kind: 'option_close', position })}
          >
            平仓
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => onOpenSheet({ kind: 'option_expire', position })}
          >
            作废
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => onOpenSheet({ kind: 'option_assign', position })}
          >
            指派
          </Button>
        </div>
      </CardPanel>
    </Card>
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
      <Card>
        <CardHeader className="gap-1 p-4 pb-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <CardDescription className="text-xs">当前账户</CardDescription>
              <CardTitle className="truncate text-base">
                {data.accounts[0]?.name ?? data.accountId}
              </CardTitle>
            </div>
            <span className="num shrink-0 text-xs text-muted-foreground">
              {data.accounts[0]?.eventCount ?? 0} 条事件
            </span>
          </div>
        </CardHeader>
        <CardPanel className="p-4 pt-0">
          <div className="grid grid-cols-3 gap-2 border-t pt-3">
            <Figure label="现金" value={money(data.summary.accountCash)} />
            <Figure label="账户数" value={data.accounts.length} />
            <Figure label="持股" value={data.summary.sharesHeld} />
          </div>
        </CardPanel>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-base">偏好</CardTitle>
        </CardHeader>
        <CardPanel className="p-4 pt-0">
          <div className="divide-y">
            <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <span>外观</span>
              <Segmented
                label="外观"
                className="w-[11.5rem]"
                value={theme}
                onChange={setTheme}
                options={[
                  { value: 'auto', label: '跟随' },
                  { value: 'light', label: '浅色' },
                  { value: 'dark', label: '深色' },
                ]}
              />
            </div>
            <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <span>数据</span>
              <Button variant="link" size="sm" onClick={onReload}>
                重新读取
              </Button>
            </div>
            <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <span>备份与同步</span>
              <Button variant="link" size="sm" onClick={onOpenWebDav}>
                WebDAV
              </Button>
            </div>
            <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <span>版本</span>
              <span className="num text-xs text-muted-foreground">0.6.0</span>
            </div>
          </div>
        </CardPanel>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-base">本机数据库</CardTitle>
        </CardHeader>
        <CardPanel className="p-4 pt-0">
          <p className="num break-all text-xs text-muted-foreground">{data.dbPath}</p>
          {data.demo && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              当前是演示账本：首次启动写入的合成数据，不是你的真实交易。接入真实账本后会替换。
            </p>
          )}
        </CardPanel>
      </Card>
    </>
  )
}
