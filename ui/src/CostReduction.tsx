import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, ScanLine, Upload } from 'lucide-react';
import type {
  Campaign, ChainImportPreview, ChainStatus, ChainSync, NewEvent, Position, ScanCandidate,
  ScanFlag, ScanOutcome, ScanPreset, ScanSettings,
} from './types';
import { api, money, percent, today } from './lib';

type Props = {
  accountId: string;
  campaigns: Campaign[];
  positions: Position[];
  initialCampaignId: string | null;
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

const kindLabels: Record<string, string> = { covered_call: '备兑 Call', cash_secured_put: '卖出 Put' };

const flagLabels: Record<ScanFlag, string> = {
  locks_loss: '锁定亏损', adds_shares: '加仓放大', insufficient_cash: '资金不足',
  partial_coverage: '覆盖不足', deep_itm: '深度实值', near_expiry: '临近到期',
  illiquid: '流动性差', chain_stale: '链已过期', estimated_price: '估算价格',
  dividend_near: '分红临近',
};

const flagTone: Partial<Record<ScanFlag, 'danger' | 'warning'>> = {
  locks_loss: 'danger', insufficient_cash: 'danger', adds_shares: 'warning', deep_itm: 'warning',
  near_expiry: 'warning', illiquid: 'warning', chain_stale: 'warning',
};

const freshnessLabel: Record<ChainStatus['status'], string> = {
  fresh: '新鲜', delayed: '延迟', stale: '过期', missing: '无数据',
};

export function CostReduction({ accountId, campaigns, positions, initialCampaignId, onEntry }: Props) {
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
    return <div className="empty panel">
      <ScanLine size={40}/>
      <h2>当前没有持股</h2>
      <p>降本扫描针对已有持股寻找期权方案。先记录一笔股票买入，再回到这里。</p>
    </div>;
  }

  const chainMissing = !chain || chain.status === 'missing';
  const chainStale = chain?.status === 'stale';

  return <div className="cost-reduction">
    <p className="footnote">只读情景分析 · 不写账本 · 不构成投资建议。所有成本与指派结果均由账本引擎投影计算，与真实入账口径一致。</p>

    {!underwater.length && <div className="alert warning" role="status">当前没有低于成本价的持股，但仍可选择任意持股做情景分析。</div>}
    {error && <div className="alert error" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}

    <section className="panel">
      <div className="section-heading">
        <h2>持仓</h2>
        <span className="muted">{underwater.length} 个低于成本 · 共 {holdings.length} 个持股战役</span>
      </div>
      <div className="filters">
        <label>战役
          <select value={campaignId} onChange={event => setCampaignId(event.target.value)}>
            {holdings.map(item => <option key={item.id} value={item.id}>
              {item.symbol} · {item.shares} 股 · 成本 {money(item.costB)}{item.price != null && item.costB != null && item.price < item.costB ? ' · 浮亏' : ''}
            </option>)}
          </select>
        </label>
      </div>
      {campaign && <div className="scan-campaign">
        <span><small>股数</small><strong>{campaign.shares}</strong></span>
        <span><small>成本 B</small><strong>{money(campaign.costB)}</strong></span>
        <span><small>现价</small><strong>{money(campaign.price)}</strong></span>
        <span><small>浮亏</small><strong className={campaign.price != null && campaign.costB != null && campaign.price < campaign.costB ? 'negative' : ''}>
          {campaign.price != null && campaign.costB != null ? money((campaign.price - campaign.costB) * campaign.shares) : '—'}
        </strong></span>
        <span><small>已覆盖 / 可用</small><strong>{coveredShares} / {freeShares}</strong></span>
      </div>}
      {campaign && <p className="muted">链：{chainMissing ? '尚无快照' : `${chain.source || 'manual'} · ${chain.quoteCount} 条 · ${freshnessLabel[chain.status]} · ${chain.fetchedAt}`}</p>}
      <div className="toolbar">
        <button disabled={!campaign || chainBusy} onClick={() => void fetchChain()}><RefreshCw size={16} className={chainBusy ? 'spinning' : ''}/>获取 Nasdaq 延迟链</button>
        <button disabled={!campaign} onClick={() => setImportOpen(open => !open)}><Upload size={16}/>粘贴导入</button>
        <button className="text-button" disabled={!symbol} onClick={() => void loadChain(symbol)}>刷新状态</button>
      </div>
      {chainStale && <div className="alert warning" role="status">链快照超过一个交易日，结果仅作估值参考；建议先刷新或重新导入。</div>}
      {chainMissing && <p className="muted">没有本地链：可获取 Nasdaq 延迟链，或从券商导出 CSV/TSV 粘贴导入（表头需含到期日、行权价、方向）。</p>}

      {importOpen && <div className="scan-import">
        <div className="form-grid">
          <label className="full">粘贴券商期权链（CSV / TSV / 分号分隔，第一行为表头）
            <textarea rows={6} value={text} onChange={event => { setText(event.target.value); setPreview(null); }} placeholder={'expiry,strike,right,bid,ask,open_interest\n2026-12-18,160,C,3.20,3.30,5000'}/>
          </label>
        </div>
        <div className="toolbar">
          <button disabled={!text.trim() || chainBusy} onClick={() => void previewImport()}>解析预览</button>
          <button className="primary" disabled={!preview || !preview.valid || chainBusy} onClick={() => void commitImport()}>确认导入</button>
          <button className="text-button" onClick={() => { setImportOpen(false); setPreview(null); }}>取消</button>
        </div>
        {preview && <div className="scan-import-preview">
          <p>可导入 <strong>{preview.valid}</strong> 行 · 跳过 <strong>{preview.invalid}</strong> 行 · 分隔符 {preview.delimiter === '\t' ? '制表符' : preview.delimiter}</p>
          {preview.errors.slice(0, 5).map(errorRow => <p key={errorRow.line} className="negative">第 {errorRow.line} 行：{errorRow.message}</p>)}
        </div>}
      </div>}
    </section>

    <section className="panel">
      <div className="section-heading"><h2>筛选</h2><span className="muted">预设只改变过滤与排序，没有综合评分</span></div>
      <div className="segmented" aria-label="扫描预设">
        {presets.map(preset => <button key={preset.id} aria-pressed={settings.preset === preset.id} onClick={() => choosePreset(preset.id)} title={preset.note}>{preset.label}</button>)}
      </div>
      <p className="muted">{presets.find(preset => preset.id === settings.preset)?.note}</p>
      <div className="filters">
        <label>到期最少（天）<input type="number" min={1} max={730} value={settings.dteMin} onChange={event => setSettings(current => ({ ...current, dteMin: Number(event.target.value) || 0 }))}/></label>
        <label>到期最多（天）<input type="number" min={1} max={730} value={settings.dteMax} onChange={event => setSettings(current => ({ ...current, dteMax: Number(event.target.value) || 0 }))}/></label>
        <label>Δ 最小<input type="number" step={0.05} min={0} max={1} value={settings.deltaMin} onChange={event => setSettings(current => ({ ...current, deltaMin: Number(event.target.value) || 0 }))}/></label>
        <label>Δ 最大<input type="number" step={0.05} min={0} max={1} value={settings.deltaMax} onChange={event => setSettings(current => ({ ...current, deltaMax: Number(event.target.value) || 0 }))}/></label>
        <label>每手手续费<input type="number" step={0.01} min={0} value={settings.feePerContract} onChange={event => setSettings(current => ({ ...current, feePerContract: Number(event.target.value) || 0 }))}/></label>
        <label>权利金口径<select value={settings.priceSource} onChange={event => setSettings(current => ({ ...current, priceSource: event.target.value === 'mark' ? 'mark' : 'bid' }))}><option value="bid">买价（保守）</option><option value="mark">中间价</option></select></label>
      </div>
      <div className="toolbar">
        <label className="check"><input type="checkbox" checked={settings.allowLockedLoss} onChange={event => setSettings(current => ({ ...current, allowLockedLoss: event.target.checked }))}/>接受行权价低于成本的 Call（锁定亏损）</label>
        <label className="check"><input type="checkbox" checked={settings.allowPuts} onChange={event => setSettings(current => ({ ...current, allowPuts: event.target.checked }))}/>允许卖出 Put</label>
        <label className="check"><input type="checkbox" checked={settings.liquidityFilter} onChange={event => setSettings(current => ({ ...current, liquidityFilter: event.target.checked }))}/>流动性过滤（OI ≥ {settings.minOpenInterest}，价差 ≤ {percent(settings.maxSpreadPct)}）</label>
      </div>
      <div className="toolbar">
        <button className="primary" disabled={!campaign || chainMissing || busy} onClick={() => void runScan()}>
          <ScanLine size={16}/>{busy ? '扫描中…' : '扫描'}
        </button>
        {chainMissing && <span className="muted">先获取或导入期权链。</span>}
      </div>
    </section>

    {outcome && <section className="panel">
      <div className="section-heading">
        <h2>方案 <span className="count">{outcome.candidates.length}</span></h2>
        <span className="muted">窗口内 {outcome.scannedQuotes} 条报价 · 投影失败 {outcome.dropped} 个</span>
      </div>
      {outcome.chainStale && <p className="muted">每行均带「链已过期」标签。</p>}
      {!outcome.candidates.length && <p className="empty">当前筛选下没有候选。可放宽容差、接受锁定亏损，或导入更完整的期权链。</p>}
      {!!outcome.candidates.length && <div className="table-wrap"><table>
        <thead><tr><th>方案</th><th>合约</th><th className="num">手数</th><th className="num">净权利金</th><th className="num">B′</th><th className="num">C′</th><th className="num">每股降本</th><th className="num">年化</th><th className="num">概率 ITM</th><th>标签</th><th>操作</th></tr></thead>
        <tbody>{outcome.candidates.map(candidate => {
          const leg = candidate.legs[0];
          const open = expanded === candidate.id;
          return <Fragment key={candidate.id}>
            <tr>
              <td>{kindLabels[candidate.kind]}</td>
              <td>{leg ? `${leg.expiry} ${leg.strike}${leg.right}` : '—'}</td>
              <td className="num">{leg?.qty ?? '—'}</td>
              <td className="num">{money(candidate.premiumTotal)}</td>
              <td className="num">{money(candidate.costBAfter)}</td>
              <td className="num">{money(candidate.costCAfter)}</td>
              <td className="num">{money(candidate.costReductionPerShare)}</td>
              <td className="num">{percent(candidate.annualized)}</td>
              <td className="num">{candidate.probItm == null ? '—' : percent(candidate.probItm)}</td>
              <td className="scan-flags">{candidate.flags.map(flag => <span key={flag} className={`badge ${flagTone[flag] ?? 'closed'}`}>{flagLabels[flag]}</span>)}</td>
              <td>
                <div className="toolbar">
                  <button className="text-button" onClick={() => setExpanded(open ? null : candidate.id)}>{open ? '收起' : '详情'}{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button>
                  <button className="text-button" onClick={() => record(candidate)}>记一笔</button>
                </div>
              </td>
            </tr>
            {open && <tr className="scan-detail"><td colSpan={11}><CandidateDetail candidate={candidate}/></td></tr>}
          </Fragment>;
        })}</tbody>
      </table></div>}
      <p className="footnote">B′ 为期权到期作废后的成本；C′ 为立即计入未平仓权利金的成本。被行权与剩余持仓数字来自同一事件流的真实重放。</p>
    </section>}
  </div>;
}

function CandidateDetail({ candidate }: { candidate: ScanCandidate }) {
  const assignment = candidate.assignment;
  const leg = candidate.legs[0];
  return <div className="scan-detail-body">
    <div className="scan-detail-grid">
      <span>权利金来源<strong>{leg?.priceSource === 'mark' ? '中间价' : '买价'}</strong></span>
      <span>手续费<strong>{money(candidate.fees)}</strong></span>
      <span>Delta<strong>{candidate.delta == null ? '—' : candidate.delta.toFixed(2)}</strong></span>
      <span>上行空间<strong>{candidate.upsideCap == null ? '—' : percent(candidate.upsideCap)}</strong></span>
      <span>占款<strong>{candidate.capital ? money(candidate.capital) : '—'}</strong></span>
      <span>保本价<strong>{money(candidate.breakeven)}</strong></span>
    </div>
    {assignment && <div className="scan-assignment">
      <p>
        <strong>被行权：</strong>
        持股 {assignment.sharesAfter} 股（{assignment.sharesChange >= 0 ? '+' : ''}{assignment.sharesChange}）·
        行权后总盈亏 {money(assignment.realizedPnl)}
        {assignment.lockedLoss ? ` · 锁定亏损 ${money(assignment.lockedLoss)}` : ''}
        {assignment.saleProceeds ? ` · 卖出所得 ${money(assignment.saleProceeds)}` : ''}
        {assignment.capitalAdded ? ` · 追加资金 ${money(assignment.capitalAdded)}` : ''}
        {assignment.closesCampaign ? ' · 战役结束' : ` · 剩余成本 ${money(assignment.remainingCostB)}`}
      </p>
      {!!candidate.stress.length && <div className="table-wrap"><table>
        <thead><tr><th>到期价</th><th>本方案盈亏</th><th>不操作盈亏</th><th>差额</th></tr></thead>
        <tbody>{candidate.stress.map(item => <tr key={item.price}>
          <td>{money(item.price)}</td>
          <td className={item.pnl < 0 ? 'negative' : 'positive'}>{money(item.pnl)}</td>
          <td className={item.baselinePnl < 0 ? 'negative' : 'positive'}>{money(item.baselinePnl)}</td>
          <td className={item.pnl - item.baselinePnl < 0 ? 'negative' : 'positive'}>{money(item.pnl - item.baselinePnl)}</td>
        </tr>)}</tbody>
      </table></div>}
    </div>}
    <p className="muted">「记一笔」只预填录入表单，仍需在录入页确认后手动保存。</p>
  </div>;
}
