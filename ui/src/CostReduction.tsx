import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDownIcon, ChevronRightIcon, RefreshCwIcon, ScanLineIcon, UploadIcon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/native-select';
import type {
  Campaign, ChainImportPreview, ChainStatus, ChainSync, NewEvent, Position, ScanCandidate,
  ScanFilters, ScanFlag, ScanOutcome, ScanPreset, ScanSettings,
} from './types';
import { api, money, percent, today } from './lib';

type Props = {
  accountId: string;
  campaigns: Campaign[];
  positions: Position[];
  initialCampaignId: string | null;
  cashTracked: boolean;
  onEntry: (prefill: Partial<NewEvent>) => void;
};

const presets: { id: ScanPreset; label: string; delta: [number, number]; note: string }[] = [
  { id: 'steady_income', label: '稳健收租', delta: [0, 0.20], note: 'Δ ≤ 0.20 · 行权价不低于成本 B' },
  { id: 'balanced', label: '平衡降本', delta: [0.20, 0.30], note: 'Δ 0.20–0.30 · 优先每股降本' },
  { id: 'aggressive', label: '激进解套', delta: [0.30, 0.45], note: 'Δ 0.30–0.45 · 允许行权价低于成本' },
  { id: 'add_position', label: '加仓摊平', delta: [0.15, 0.30], note: '只卖 Put · 优先指派后成本最低' },
];

const defaultSettings: ScanSettings = {
  dteMin: 14, dteMax: 45, deltaMin: 0.20, deltaMax: 0.30,
  allowLockedLoss: false, allowPuts: false, maxSharesMultiple: 2, maxExtraCapital: null,
  feePerContract: 0.65, priceSource: 'bid', liquidityFilter: true, minOpenInterest: 100,
  maxSpreadPct: 0.10, riskFreeRate: 0.04, dividendYield: 0, putMaxStrikeRatio: 0.98,
  preset: 'balanced', projectionLimit: 40,
};

const emptyFilters: ScanFilters = {
  totalQuotes: 0, invalidQuotes: 0, outsideDte: 0, callsDisabled: 0, putsDisabled: 0,
  missingPrice: 0, illiquid: 0, outsideDelta: 0, belowCost: 0, putStrikeTooHigh: 0,
  noQuantity: 0, noPremium: 0,
};

const kindLabels: Record<string, string> = { covered_call: '备兑 Call', cash_secured_put: '卖出 Put' };

const flagLabels: Record<ScanFlag, string> = {
  locks_loss: '锁定亏损', adds_shares: '加仓放大', insufficient_cash: '资金不足',
  partial_coverage: '覆盖不足', deep_itm: '深度实值', near_expiry: '临近到期',
  illiquid: '流动性差', chain_stale: '链已过期', estimated_price: '估算价格',
  dividend_near: '分红临近',
};

const flagTone: Partial<Record<ScanFlag, 'destructive' | 'warning'>> = {
  locks_loss: 'destructive', insufficient_cash: 'destructive', adds_shares: 'warning', deep_itm: 'warning',
  near_expiry: 'warning', illiquid: 'warning', chain_stale: 'warning',
};

const freshnessLabel: Record<ChainStatus['status'], string> = {
  fresh: '新鲜', delayed: '延迟', stale: '过期', missing: '无数据',
};

function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={`grid gap-1.5 text-xs font-medium text-muted-foreground ${className ?? ''}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function CostReduction({ accountId, campaigns, positions, initialCampaignId, cashTracked, onEntry }: Props) {
  const holdings = useMemo(
    () => campaigns.filter(campaign => campaign.shares > 0),
    [campaigns],
  );
  const underwater = useMemo(
    () => holdings.filter(campaign => campaign.price != null && campaign.costB != null && campaign.price < campaign.costB),
    [holdings],
  );
  const [campaignId, setCampaignId] = useState(initialCampaignId ?? underwater[0]?.id ?? holdings[0]?.id ?? '');
  const [settings, setSettings] = useState<ScanSettings>(defaultSettings);
  const [chain, setChain] = useState<ChainStatus | null>(null);
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chainBusy, setChainBusy] = useState(false);
  const [error, setError] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ChainImportPreview | null>(null);

  const campaign = campaigns.find(item => item.id === campaignId) ?? null;
  const symbol = campaign?.symbol ?? '';
  // Only calls count as coverage; puts add shares instead of releasing them.
  const coveredShares = campaign
    ? positions
      .filter(position => position.campaignId === campaign.id && position.right === 'C')
      .reduce((total, position) => total + position.openQty * position.multiplier, 0)
    : 0;
  const freeShares = campaign ? Math.max(0, campaign.shares - coveredShares) : 0;

  useEffect(() => {
    if (initialCampaignId) setCampaignId(initialCampaignId);
  }, [initialCampaignId]);

  const loadChain = useCallback(async (target: string) => {
    if (!target) { setChain(null); return; }
    try {
      const list = await api<ChainStatus[]>('option_chain_status', { symbols: [target] });
      setChain(list[0] ?? null);
    } catch (failure) {
      setError(String(failure));
    }
  }, []);

  useEffect(() => {
    setOutcome(null);
    setExpanded(null);
    void loadChain(symbol);
  }, [symbol, loadChain]);

  function choosePreset(id: ScanPreset) {
    const preset = presets.find(item => item.id === id);
    if (!preset) return;
    setSettings(current => ({
      ...current,
      preset: id,
      deltaMin: preset.delta[0],
      deltaMax: preset.delta[1],
      allowLockedLoss: id === 'aggressive' ? true : current.allowLockedLoss,
    }));
  }

  async function fetchChain() {
    if (!symbol) return;
    setChainBusy(true); setError('');
    try {
      const result = await api<ChainSync>('fetch_option_chain', { symbol });
      setChain(result.status);
    } catch (failure) {
      // The previous snapshot stays readable; surface the provider error.
      setError(String(failure));
      await loadChain(symbol);
    } finally {
      setChainBusy(false);
    }
  }

  async function previewImport() {
    setChainBusy(true); setError('');
    try {
      setPreview(await api<ChainImportPreview>('option_chain_preview', { text }));
    } catch (failure) {
      setPreview(null);
      setError(String(failure));
    } finally {
      setChainBusy(false);
    }
  }

  async function commitImport() {
    if (!symbol) return;
    setChainBusy(true); setError('');
    try {
      const result = await api<ChainSync>('option_chain_commit', { symbol, text, source: 'manual' });
      setChain(result.status);
      setImportOpen(false); setText(''); setPreview(null);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setChainBusy(false);
    }
  }

  async function runScan() {
    if (!campaign) return;
    setBusy(true); setError(''); setOutcome(null); setExpanded(null);
    try {
      setOutcome(await api<ScanOutcome>('scan_cost_reduction', {
        accountId,
        campaignId: campaign.id,
        settings,
      }));
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  function record(candidate: ScanCandidate) {
    const leg = candidate.legs[0];
    if (!campaign || !leg) return;
    const note = `降本扫描 · ${kindLabels[candidate.kind]} · 到期后成本 ${candidate.costBAfter?.toFixed(2) ?? '—'}`;
    onEntry({
      kind: 'option_open_short',
      date: today(),
      symbol: campaign.symbol,
      qty: leg.qty,
      price: leg.price,
      fees: candidate.fees,
      expiry: leg.expiry,
      strike: leg.strike,
      right: leg.right,
      multiplier: leg.multiplier,
      note,
    });
  }

  if (!holdings.length) {
    return (
      <Card>
        <CardPanel>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><ScanLineIcon /></EmptyMedia>
              <EmptyTitle>当前没有持股</EmptyTitle>
              <EmptyDescription>降本扫描针对已有持股寻找期权方案。先记录一笔股票买入，再回到这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardPanel>
      </Card>
    );
  }

  const chainMissing = !chain || chain.status === 'missing';
  const chainStale = chain?.status === 'stale';

  return (
    <div className="cost-reduction grid gap-5">
      <p className="footnote text-xs leading-relaxed text-muted-foreground">只读情景分析 · 不写账本 · 不构成投资建议。所有成本与指派结果均由账本引擎投影计算，与真实入账口径一致。</p>

      {!underwater.length && <Alert variant="warning" role="status" className="alert warning">当前没有低于成本价的持股，但仍可选择任意持股做情景分析。</Alert>}
      {error && (
        <Alert variant="error" role="alert" className="alert error">
          <span className="flex-1">{error}</span>
          <Button variant="link" size="xs" onClick={() => setError('')}>关闭</Button>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">持仓</CardTitle>
          <CardDescription>{underwater.length} 个低于成本 · 共 {holdings.length} 个持股战役</CardDescription>
        </CardHeader>
        <CardPanel className="space-y-3">
          <Field label="战役">
            <NativeSelect value={campaignId} onChange={event => setCampaignId(event.target.value)}>
              {holdings.map(item => (
                <option key={item.id} value={item.id}>
                  {item.symbol} · {item.shares} 股 · 成本 {money(item.costB)}{item.price != null && item.costB != null && item.price < item.costB ? ' · 浮亏' : ''}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {campaign && (
            <div className="scan-campaign grid gap-3 rounded-xl border bg-muted/40 p-4 sm:grid-cols-5">
              <div className="grid gap-0.5"><small className="text-xs text-muted-foreground">股数</small><strong className="num text-lg font-semibold">{campaign.shares}</strong></div>
              <div className="grid gap-0.5"><small className="text-xs text-muted-foreground">成本 B</small><strong className="num text-lg font-semibold">{money(campaign.costB)}</strong></div>
              <div className="grid gap-0.5"><small className="text-xs text-muted-foreground">现价</small><strong className="num text-lg font-semibold">{money(campaign.price)}</strong></div>
              <div className="grid gap-0.5">
                <small className="text-xs text-muted-foreground">浮亏</small>
                <strong className={`num text-lg font-semibold ${campaign.price != null && campaign.costB != null && campaign.price < campaign.costB ? 'negative text-destructive-foreground' : ''}`}>
                  {campaign.price != null && campaign.costB != null ? money((campaign.price - campaign.costB) * campaign.shares) : '—'}
                </strong>
              </div>
              <div className="grid gap-0.5"><small className="text-xs text-muted-foreground">已覆盖 / 可用</small><strong className="num text-lg font-semibold">{coveredShares} / {freeShares}</strong></div>
            </div>
          )}
          {campaign && <p className="text-xs text-muted-foreground">链：{chainMissing ? '尚无快照' : `${chain.source || 'manual'} · ${chain.quoteCount} 条 · ${freshnessLabel[chain.status]} · ${chain.fetchedAt}`}</p>}
          {campaign && freeShares === 0 && (
            <Alert variant="warning" role="status" className="alert warning">
              {campaign.shares} 股已全部被未平仓 Call 覆盖，可用股数为 0，无法再卖出备兑 Call。先了结现有 Call，或换一个持股战役。
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={!campaign || chainBusy} onClick={() => void fetchChain()}>
              {chainBusy ? <Spinner className="size-4" /> : <RefreshCwIcon />}
              获取 Nasdaq 延迟链
            </Button>
            <Button variant="outline" size="sm" disabled={!campaign} onClick={() => setImportOpen(open => !open)}><UploadIcon />粘贴导入</Button>
            <Button variant="link" size="sm" disabled={!symbol} onClick={() => void loadChain(symbol)}>刷新状态</Button>
          </div>
          {chainStale && <Alert variant="warning" role="status" className="alert warning">链快照超过一个交易日，结果仅作估值参考；建议先刷新或重新导入。</Alert>}
          {chainMissing && <p className="text-xs leading-relaxed text-muted-foreground">没有本地链：可获取 Nasdaq 延迟链，或从券商导出 CSV/TSV 粘贴导入（表头需含到期日、行权价、方向）。</p>}

          {importOpen && (
            <div className="scan-import space-y-3 rounded-xl border p-4">
              <Field label="粘贴券商期权链（CSV / TSV / 分号分隔，第一行为表头）">
                <Textarea rows={6} className="font-mono text-xs" value={text} onChange={event => { setText(event.target.value); setPreview(null); }} placeholder={'expiry,strike,right,bid,ask,open_interest\n2026-12-18,160,C,3.20,3.30,5000'} />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={!text.trim() || chainBusy} onClick={() => void previewImport()}>解析预览</Button>
                <Button size="sm" disabled={!preview || !preview.valid || chainBusy} onClick={() => void commitImport()}>确认导入</Button>
                <Button variant="link" size="sm" onClick={() => { setImportOpen(false); setPreview(null); }}>取消</Button>
              </div>
              {preview && (
                <div className="scan-import-preview space-y-1 text-xs">
                  <p className="text-muted-foreground">可导入 <strong className="text-foreground">{preview.valid}</strong> 行 · 跳过 <strong className="text-foreground">{preview.invalid}</strong> 行 · 分隔符 {preview.delimiter === '\t' ? '制表符' : preview.delimiter}</p>
                  {preview.errors.slice(0, 5).map(errorRow => <p key={errorRow.line} className="negative text-destructive-foreground">第 {errorRow.line} 行：{errorRow.message}</p>)}
                </div>
              )}
            </div>
          )}
        </CardPanel>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">筛选</CardTitle>
          <CardDescription>预设只改变过滤与排序，没有综合评分</CardDescription>
        </CardHeader>
        <CardPanel className="space-y-3">
          <div className="segmented flex w-fit flex-wrap items-center gap-0.5 rounded-lg bg-muted p-0.5" aria-label="扫描预设">
            {presets.map(preset => (
              <Button
                key={preset.id}
                type="button"
                size="sm"
                variant={settings.preset === preset.id ? 'outline' : 'ghost'}
                aria-pressed={settings.preset === preset.id}
                title={preset.note}
                onClick={() => choosePreset(preset.id)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{presets.find(preset => preset.id === settings.preset)?.note}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="到期最少（天）"><Input type="number" min={1} max={730} value={settings.dteMin} onChange={event => setSettings(current => ({ ...current, dteMin: Number(event.target.value) || 0 }))} /></Field>
            <Field label="到期最多（天）"><Input type="number" min={1} max={730} value={settings.dteMax} onChange={event => setSettings(current => ({ ...current, dteMax: Number(event.target.value) || 0 }))} /></Field>
            <Field label="Δ 最小"><Input type="number" step={0.05} min={0} max={1} value={settings.deltaMin} onChange={event => setSettings(current => ({ ...current, deltaMin: Number(event.target.value) || 0 }))} /></Field>
            <Field label="Δ 最大"><Input type="number" step={0.05} min={0} max={1} value={settings.deltaMax} onChange={event => setSettings(current => ({ ...current, deltaMax: Number(event.target.value) || 0 }))} /></Field>
            <Field label="每手手续费"><Input type="number" step={0.01} min={0} value={settings.feePerContract} onChange={event => setSettings(current => ({ ...current, feePerContract: Number(event.target.value) || 0 }))} /></Field>
            <Field label="最小未平仓量"><Input type="number" min={0} step={50} value={settings.minOpenInterest} onChange={event => setSettings(current => ({ ...current, minOpenInterest: Math.max(0, Number(event.target.value) || 0) }))} /></Field>
            <Field label="最大价差（%）"><Input type="number" min={0} max={100} step={1} value={Math.round(settings.maxSpreadPct * 1000) / 10} onChange={event => setSettings(current => ({ ...current, maxSpreadPct: Math.max(0, Number(event.target.value) || 0) / 100 }))} /></Field>
            <Field label="权利金口径">
              <NativeSelect value={settings.priceSource} onChange={event => setSettings(current => ({ ...current, priceSource: event.target.value === 'mark' ? 'mark' : 'bid' }))}>
                <option value="bid">买价（保守）</option>
                <option value="mark">中间价</option>
              </NativeSelect>
            </Field>
          </div>
          <div className="flex flex-col gap-2 pt-1">
            <label className="check flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-3.5 rounded border-input accent-primary" checked={settings.allowLockedLoss} onChange={event => setSettings(current => ({ ...current, allowLockedLoss: event.target.checked }))} />
              接受行权价低于成本的 Call（锁定亏损）
            </label>
            <label className={`check flex items-start gap-2 text-sm ${cashTracked ? '' : 'opacity-60'}`}>
              <input type="checkbox" className="mt-0.5 size-3.5 rounded border-input accent-primary" disabled={!cashTracked} checked={settings.allowPuts} onChange={event => setSettings(current => ({ ...current, allowPuts: event.target.checked }))} />
              允许卖出 Put
            </label>
            {!cashTracked && <p className="pl-5 text-xs leading-relaxed text-muted-foreground">该账户没有记录入金 / 出金，卖出 Put 无法计算资金与手数；先在仪表盘记录现金流水。</p>}
            <label className="check flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-3.5 rounded border-input accent-primary" checked={settings.liquidityFilter} onChange={event => setSettings(current => ({ ...current, liquidityFilter: event.target.checked }))} />
              流动性过滤（OI ≥ {settings.minOpenInterest}，价差 ≤ {percent(settings.maxSpreadPct)}）
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t pt-3">
            <Button disabled={!campaign || chainMissing || busy} onClick={() => void runScan()}>
              {busy ? <Spinner className="size-4" /> : <ScanLineIcon />}
              {busy ? '扫描中…' : '扫描'}
            </Button>
            {chainMissing && <span className="text-xs text-muted-foreground">先获取或导入期权链。</span>}
          </div>
        </CardPanel>
      </Card>

      {outcome && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">方案 <Badge variant="secondary" size="sm">{outcome.candidates.length}</Badge></CardTitle>
            <CardDescription>链上 {outcome.filters?.totalQuotes ?? 0} 条 · 窗口内 {outcome.scannedQuotes} 条 · 投影失败 {outcome.dropped} 个</CardDescription>
          </CardHeader>
          <CardPanel className="space-y-3">
            {outcome.chainStale && <p className="text-xs text-muted-foreground">每行均带「链已过期」标签。</p>}
            {!outcome.candidates.length && <ScanEmptyState outcome={outcome} settings={settings} />}
            {!!outcome.candidates.length && (
              <div className="overflow-hidden rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>方案</TableHead>
                      <TableHead>合约</TableHead>
                      <TableHead className="text-right">手数</TableHead>
                      <TableHead className="text-right">净权利金</TableHead>
                      <TableHead className="text-right">B′</TableHead>
                      <TableHead className="text-right">C′</TableHead>
                      <TableHead className="text-right">每股降本</TableHead>
                      <TableHead className="text-right">年化</TableHead>
                      <TableHead className="text-right">概率 ITM</TableHead>
                      <TableHead>标签</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {outcome.candidates.map(candidate => {
                      const leg = candidate.legs[0];
                      const open = expanded === candidate.id;
                      return (
                        <Fragment key={candidate.id}>
                          <TableRow>
                            <TableCell>{kindLabels[candidate.kind]}</TableCell>
                            <TableCell className="num">{leg ? `${leg.expiry} ${leg.strike}${leg.right}` : '—'}</TableCell>
                            <TableCell className="num text-right">{leg?.qty ?? '—'}</TableCell>
                            <TableCell className="num text-right">{money(candidate.premiumTotal)}</TableCell>
                            <TableCell className="num text-right">{money(candidate.costBAfter)}</TableCell>
                            <TableCell className="num text-right">{money(candidate.costCAfter)}</TableCell>
                            <TableCell className="num text-right">{money(candidate.costReductionPerShare)}</TableCell>
                            <TableCell className="num text-right">{percent(candidate.annualized)}</TableCell>
                            <TableCell className="num text-right">{candidate.probItm == null ? '—' : percent(candidate.probItm)}</TableCell>
                            <TableCell>
                              <div className="scan-flags flex flex-wrap gap-1">
                                {candidate.flags.map(flag => (
                                  <Badge key={flag} variant={flagTone[flag] ?? 'outline'} size="sm">{flagLabels[flag]}</Badge>
                                ))}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap justify-end gap-1">
                                <Button variant="ghost" size="xs" onClick={() => setExpanded(open ? null : candidate.id)}>
                                  {open ? '收起' : '详情'}{open ? <ChevronDownIcon /> : <ChevronRightIcon />}
                                </Button>
                                <Button variant="outline" size="xs" onClick={() => record(candidate)}>记一笔</Button>
                              </div>
                            </TableCell>
                          </TableRow>
                          {open && (
                            <TableRow className="scan-detail">
                              <TableCell colSpan={11} className="bg-muted/30">
                                <CandidateDetail candidate={candidate} />
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
            <p className="footnote text-xs leading-relaxed text-muted-foreground">B′ 为期权到期作废后的成本；C′ 为立即计入未平仓权利金的成本。被行权与剩余持仓数字来自同一事件流的真实重放。</p>
          </CardPanel>
        </Card>
      )}
    </div>
  );
}

function ScanEmptyState({ outcome, settings }: { outcome: ScanOutcome; settings: ScanSettings }) {
  const filters = outcome.filters ?? emptyFilters;
  const reasons: string[] = [];
  if (outcome.campaign.freeShares === 0 && settings.preset !== 'add_position') {
    reasons.push(`可用股数 0：${outcome.campaign.coveredShares} 股已被未平仓 Call 覆盖，无法再卖出备兑 Call。先了结现有 Call，或换一个持股战役。`);
  }
  if (filters.outsideDte) reasons.push(`${filters.outsideDte} 条报价不在 ${settings.dteMin}–${settings.dteMax} 天到期窗口内，可放宽到期范围。`);
  if (filters.callsDisabled) reasons.push(`${filters.callsDisabled} 条 Call 因当前预设只卖 Put 而跳过。`);
  if (filters.putsDisabled) {
    reasons.push(outcome.campaign.cashTracked
      ? `${filters.putsDisabled} 条 Put 因未开启「允许卖出 Put」而跳过。`
      : `${filters.putsDisabled} 条 Put 被跳过：该账户没有记录入金 / 出金，卖出 Put 无法计算资金与手数。`);
  } else if (!outcome.campaign.cashTracked && settings.allowPuts) {
    reasons.push('该账户没有记录入金 / 出金，卖出 Put 无法计算资金与手数。');
  }
  if (filters.missingPrice) reasons.push(`${filters.missingPrice} 条报价缺少可用的买价 / 中间价。`);
  if (filters.illiquid) reasons.push(`${filters.illiquid} 条报价未通过流动性过滤（OI ≥ ${settings.minOpenInterest}，价差 ≤ ${percent(settings.maxSpreadPct)}）；可取消勾选或放宽阈值。`);
  if (filters.outsideDelta) reasons.push(`${filters.outsideDelta} 条报价的 |Δ| 不在 ${settings.deltaMin}–${settings.deltaMax}。`);
  if (filters.belowCost) reasons.push(`${filters.belowCost} 条 Call 行权价低于成本 B；勾选「接受行权价低于成本的 Call」可查看这些方案。`);
  if (filters.putStrikeTooHigh) reasons.push(`${filters.putStrikeTooHigh} 条 Put 行权价高于现价的 ${percent(settings.putMaxStrikeRatio)}。`);
  if (filters.noQuantity) reasons.push(`${filters.noQuantity} 条报价可交易但手数为 0：可用股数或现金不足。`);
  if (filters.noPremium) reasons.push(`${filters.noPremium} 条报价扣除手续费后没有正的净权利金。`);
  if (filters.invalidQuotes) reasons.push(`${filters.invalidQuotes} 条报价缺少有效的行权价或乘数。`);

  return (
    <div className="scan-empty-reasons space-y-2">
      <p className="text-sm text-muted-foreground">当前筛选下没有候选。主要原因：</p>
      {reasons.length ? (
        <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
          {reasons.map(reason => <li key={reason}>{reason}</li>)}
        </ul>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">可放宽容差、接受锁定亏损，或导入更完整的期权链。</p>
      )}
      {outcome.dropped > 0 && <p className="text-xs leading-relaxed text-muted-foreground">另有 {outcome.dropped} 个候选在账本投影时失败，已从结果中移除。</p>}
    </div>
  );
}

function CandidateDetail({ candidate }: { candidate: ScanCandidate }) {
  const assignment = candidate.assignment;
  const leg = candidate.legs[0];
  return (
    <div className="scan-detail-body space-y-3 py-2">
      <div className="scan-detail-grid grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <span className="grid gap-0.5 text-xs text-muted-foreground">权利金来源<strong className="num text-sm font-medium text-foreground">{leg?.priceSource === 'mark' ? '中间价' : '买价'}</strong></span>
        <span className="grid gap-0.5 text-xs text-muted-foreground">手续费<strong className="num text-sm font-medium text-foreground">{money(candidate.fees)}</strong></span>
        <span className="grid gap-0.5 text-xs text-muted-foreground">Delta<strong className="num text-sm font-medium text-foreground">{candidate.delta == null ? '—' : candidate.delta.toFixed(2)}</strong></span>
        <span className="grid gap-0.5 text-xs text-muted-foreground">上行空间<strong className="num text-sm font-medium text-foreground">{candidate.upsideCap == null ? '—' : percent(candidate.upsideCap)}</strong></span>
        <span className="grid gap-0.5 text-xs text-muted-foreground">占款<strong className="num text-sm font-medium text-foreground">{candidate.capital ? money(candidate.capital) : '—'}</strong></span>
        <span className="grid gap-0.5 text-xs text-muted-foreground">保本价<strong className="num text-sm font-medium text-foreground">{money(candidate.breakeven)}</strong></span>
      </div>
      {assignment && (
        <div className="scan-assignment space-y-2">
          <p className="text-sm">
            <strong>被行权：</strong>
            持股 {assignment.sharesAfter} 股（{assignment.sharesChange >= 0 ? '+' : ''}{assignment.sharesChange}）·
            行权后总盈亏 {money(assignment.realizedPnl)}
            {assignment.lockedLoss ? ` · 锁定亏损 ${money(assignment.lockedLoss)}` : ''}
            {assignment.saleProceeds ? ` · 卖出所得 ${money(assignment.saleProceeds)}` : ''}
            {assignment.capitalAdded ? ` · 追加资金 ${money(assignment.capitalAdded)}` : ''}
            {assignment.closesCampaign ? ' · 战役结束' : ` · 剩余成本 ${money(assignment.remainingCostB)}`}
          </p>
          {!!candidate.stress.length && (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>到期价</TableHead>
                    <TableHead className="text-right">本方案盈亏</TableHead>
                    <TableHead className="text-right">不操作盈亏</TableHead>
                    <TableHead className="text-right">差额</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {candidate.stress.map(item => (
                    <TableRow key={item.price}>
                      <TableCell className="num">{money(item.price)}</TableCell>
                      <TableCell className={`num text-right ${item.pnl < 0 ? 'negative text-destructive-foreground' : 'positive text-success-foreground'}`}>{money(item.pnl)}</TableCell>
                      <TableCell className={`num text-right ${item.baselinePnl < 0 ? 'negative text-destructive-foreground' : 'positive text-success-foreground'}`}>{money(item.baselinePnl)}</TableCell>
                      <TableCell className={`num text-right ${item.pnl - item.baselinePnl < 0 ? 'negative text-destructive-foreground' : 'positive text-success-foreground'}`}>{money(item.pnl - item.baselinePnl)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">「记一笔」只预填录入表单，仍需在录入页确认后手动保存。</p>
    </div>
  );
}
