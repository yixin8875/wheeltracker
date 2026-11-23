import { useState, type FormEvent, type ReactNode } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/native-select';
import { api, labels, money, percent, today } from './lib';
import type { Campaign, NewEvent, Position } from './types';
import { SymbolPicker } from './SymbolPicker';
import { QuoteReference } from './MarketData';

function Field({ label, hint, className, children }: { label: ReactNode; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <label className={`grid gap-1.5 text-xs font-medium text-muted-foreground ${className ?? ''}`}>
      <span>{label}</span>
      {children}
      {hint ? <span className="font-normal">{hint}</span> : null}
    </label>
  );
}

function Value({ label, children, tone }: { label: ReactNode; children: ReactNode; tone?: 'positive' | 'negative' }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`num text-sm font-medium ${tone === 'negative' ? 'negative text-destructive-foreground' : tone === 'positive' ? 'positive text-success-foreground' : ''}`}>{children}</dd>
    </div>
  );
}

export function EntryForm({ initial, eventId, onCancel, positions, campaigns, includeDividendsInCost = false, accountId, onSaved }: { initial?: Partial<NewEvent>; eventId?: string; onCancel?: () => void; positions: Position[]; campaigns: Campaign[]; includeDividendsInCost?: boolean; accountId: string; onSaved: (message: string) => void }) {
  const defaults: NewEvent = { date: today(), kind: 'option_open_short', symbol: '', qty: 1, price: 0, fees: 0, amount: 0, expiry: '', strike: 0, right: 'P', multiplier: 100, splitNumerator: 2, splitDenominator: 1, note: '' };
  const editing = Boolean(eventId);
  const [form, setForm] = useState<NewEvent>({ ...defaults, ...initial }); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [keep, setKeep] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [roll, setRoll] = useState(false);
  const [next, setNext] = useState({ expiry: '', strike: 0, price: 0, fees: 0 });
  const rolling = roll && form.kind === 'option_close';
  const option = form.kind.startsWith('option_'); const amountOnly = ['fee', 'adjustment'].includes(form.kind);
  const cashKind = ['cash_deposit', 'cash_withdrawal'].includes(form.kind);
  const split = form.kind === 'stock_split';
  const multiplier = form.multiplier && form.multiplier > 0 ? form.multiplier : 100;
  const hasPrice = !['option_expire', 'option_assign'].includes(form.kind) && !amountOnly && !split && !cashKind;
  const hasFees = !['option_expire', 'dividend', 'fee', 'adjustment'].includes(form.kind) && !split && !cashKind;
  const update = <K extends keyof NewEvent>(key: K, value: NewEvent[K]) => setForm(previous => ({ ...previous, [key]: value }));
  const cash = form.kind === 'option_open_short' ? form.price * multiplier * form.qty - form.fees : form.kind === 'option_close' ? -form.price * multiplier * form.qty - form.fees : form.kind === 'option_assign' ? (form.right === 'P' ? -((form.strike ?? 0) * multiplier * form.qty + form.fees) : (form.strike ?? 0) * multiplier * form.qty - form.fees) : form.kind === 'shares_buy' ? -form.price * form.qty - form.fees : form.kind === 'shares_sell' ? form.price * form.qty - form.fees : form.kind === 'dividend' ? form.price * form.qty : form.kind === 'fee' ? -form.amount : form.kind === 'adjustment' ? form.amount : cashKind ? (form.kind === 'cash_deposit' ? form.amount : -form.amount) : split ? (form.splitCashInLieu ?? 0) : null;
  const collateral = option && form.strike ? form.strike * multiplier * form.qty : 0;
  const days = form.expiry ? Math.round((Date.parse(form.expiry) - Date.parse(form.date)) / 86400000) : 0;
  const upperSymbol = form.symbol.trim().toUpperCase();
  const assignmentPosition = form.kind === 'option_assign'
    ? positions.find(position => position.symbol === upperSymbol && position.expiry === form.expiry && position.strike === form.strike && position.right === form.right)
    : undefined;
  const assignmentCampaign = assignmentPosition ? campaigns.find(campaign => campaign.id === assignmentPosition.campaignId) : undefined;
  const splitCampaign = split ? campaigns.find(campaign => campaign.symbol === upperSymbol && campaign.status === 'active') : undefined;
  const previewCampaign = assignmentCampaign ?? splitCampaign;
  const baseShares = previewCampaign?.shares ?? 0;
  const baseCostTotal = previewCampaign && previewCampaign.costA != null ? previewCampaign.costA * previewCampaign.shares : 0;
  const basePremiumRealized = previewCampaign?.premiumRealized ?? 0;
  const basePremiumOpen = previewCampaign?.premiumOpen ?? 0;
  const baseDividends = includeDividendsInCost ? previewCampaign?.dividends ?? 0 : 0;
  const assignedShares = multiplier * form.qty;
  const assignedPremium = assignmentPosition ? assignmentPosition.avgCredit * multiplier * form.qty : 0;
  const putSharesAfter = baseShares + assignedShares;
  const putCostTotal = baseCostTotal + (form.strike ?? 0) * assignedShares + form.fees;
  const putCostA = putSharesAfter > 0 ? putCostTotal / putSharesAfter : null;
  const putCostB = putSharesAfter > 0 ? (putCostTotal - basePremiumRealized - assignedPremium - baseDividends) / putSharesAfter : null;
  const putPremiumOpen = Math.max(0, basePremiumOpen - assignedPremium);
  const putCostC = putSharesAfter > 0 ? (putCostTotal - basePremiumRealized - assignedPremium - putPremiumOpen - baseDividends) / putSharesAfter : null;
  const callAllocated = baseShares > 0 ? baseCostTotal * Math.min(1, assignedShares / baseShares) : 0;
  const callRemainingShares = Math.max(0, baseShares - assignedShares);
  const callRemainingCost = Math.max(0, baseCostTotal - callAllocated);
  const callProceeds = (form.strike ?? 0) * assignedShares - form.fees;
  const callSharePnl = callProceeds - callAllocated;
  const callPremiumOpen = Math.max(0, basePremiumOpen - assignedPremium);
  const callCostA = callRemainingShares > 0 ? callRemainingCost / callRemainingShares : null;
  const callCostB = callRemainingShares > 0 ? (callRemainingCost - basePremiumRealized - assignedPremium - baseDividends) / callRemainingShares : null;
  const callCostC = callRemainingShares > 0 ? (callRemainingCost - basePremiumRealized - assignedPremium - callPremiumOpen - baseDividends) / callRemainingShares : null;
  const splitNumerator = form.splitNumerator ?? 2;
  const splitDenominator = form.splitDenominator ?? 1;
  const splitRatio = splitDenominator > 0 ? splitNumerator / splitDenominator : 0;
  const splitExact = baseShares * splitRatio;
  const splitShares = Math.floor(splitExact);
  const splitFraction = splitExact - splitShares;
  const splitHasFraction = splitFraction > 1e-9;
  const splitAllocated = splitHasFraction && splitExact > 0 ? baseCostTotal * splitFraction / splitExact : 0;
  const splitCostTotal = baseCostTotal - splitAllocated;
  const splitCostA = splitShares > 0 ? splitCostTotal / splitShares : null;
  const splitCostB = splitShares > 0 ? (splitCostTotal - basePremiumRealized - baseDividends) / splitShares : null;
  const splitCostC = splitShares > 0 ? (splitCostTotal - basePremiumRealized - basePremiumOpen - baseDividends) / splitShares : null;
  const splitPositions = splitCampaign ? positions.filter(position => position.campaignId === splitCampaign.id).map(position => {
    const scaled = position.multiplier * splitNumerator;
    const multiplierOk = splitDenominator > 0 && scaled % splitDenominator === 0;
    return {
      contract: position.contract,
      newStrike: Math.round(position.strike * splitDenominator / splitNumerator * 10_000) / 10_000,
      newMultiplier: multiplierOk ? scaled / splitDenominator : null,
    };
  }) : [];
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || submitted) return;
    setError(''); setBusy(true);
    try {
      const req = { ...form, accountId, symbol: cashKind ? '' : form.symbol.trim().toUpperCase(), ...(!option ? { expiry: undefined, strike: undefined, right: undefined, multiplier: undefined } : {}), ...(!hasPrice ? { price: 0 } : {}), ...(!hasFees ? { fees: 0 } : {}), ...(split ? { qty: 0, amount: 0 } : { splitNumerator: undefined, splitDenominator: undefined, splitCashInLieu: undefined }), ...(cashKind ? { qty: 0, amount: Math.abs(form.amount) } : {}) };
      if (rolling) {
        await api<string[]>('add_events', { reqs: [req, { ...req, kind: 'option_open_short', ...next }] });
      } else if (eventId) {
        await api<string>('update_event', { eventId, req });
      } else {
        await api<string>('add_event', { req });
      }
      if (editing) {
        setSubmitted(true);
        onSaved('交易已修改，持仓与成本已重算。');
      } else {
        if (keep) {
          setForm({ ...defaults, date: form.date, symbol: form.symbol, kind: form.kind, right: form.right });
          setNext({ expiry: '', strike: 0, price: 0, fees: 0 });
        } else {
          setSubmitted(true);
        }
        onSaved('交易已保存，持仓与成本已重算。');
      }
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  function choosePosition(index: string) { const position = positions[Number(index)]; if (!position) return; setForm(previous => ({ ...previous, symbol: position.symbol, expiry: position.expiry, strike: position.strike, right: position.right, multiplier: position.multiplier, qty: position.openQty, date: previous.kind === 'option_expire' ? position.expiry : previous.date })); }

  return (
    <section className="entry-panel">
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-base">{editing ? '修改交易' : '记录交易'}</CardTitle>
          <CardDescription>
            {editing ? '保留原记录 ID 与序号 · 保存前重新回放整本账' : split ? 'USD · 新股数 = 旧股数 × 分子 ÷ 分母' : `USD · 1 手 = ${multiplier} 股`}
          </CardDescription>
        </CardHeader>
        <CardPanel>
          <form onSubmit={save} className="space-y-5">
            {error && <Alert variant="error" className="alert error">保存失败：{error}</Alert>}

            {!editing && form.kind === 'option_close' && (
              <label className="check flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-3.5 rounded border-input accent-primary" checked={roll} onChange={e => setRoll(e.target.checked)} />
                滚动：平仓后同时开出新合约
              </label>
            )}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="交易类型">
                <NativeSelect value={form.kind} onChange={e => update('kind', e.target.value)}>
                  {Object.keys(labels).filter(key => key.startsWith('option_') || ['stock_split', 'shares_buy', 'shares_sell', 'dividend', 'fee', 'adjustment', 'cash_deposit', 'cash_withdrawal'].includes(key)).map(kind => <option key={kind} value={kind}>{labels[kind]}</option>)}
                </NativeSelect>
              </Field>
              <Field label="交易日（美东）">
                <Input type="date" required value={form.date} onChange={e => update('date', e.target.value)} />
              </Field>
              {option && form.kind !== 'option_open_short' && (
                <Field label="选择当前持仓" className="sm:col-span-2 lg:col-span-1">
                  <NativeSelect defaultValue="" onChange={e => choosePosition(e.target.value)}>
                    <option value="" disabled>选择合约以自动填写</option>
                    {positions.map((position, i) => <option key={position.contract} value={i}>{position.contract} · {position.openQty} 手</option>)}
                  </NativeSelect>
                </Field>
              )}

              {!cashKind && (
                <div className="grid gap-4 sm:col-span-2 lg:col-span-3 lg:grid-cols-2">
                  <SymbolPicker autoFocus value={form.symbol} onChange={symbol => update('symbol', symbol)} />
                  <QuoteReference symbol={form.symbol} />
                </div>
              )}

              {!amountOnly && !split && !cashKind && (
                <Field label={option ? '手数' : '股数'}>
                  <Input type="number" required min="1" step="1" value={form.qty} onChange={e => update('qty', e.target.valueAsNumber)} />
                </Field>
              )}

              {option && (
                <>
                  <Field label="到期日">
                    <Input type="date" required value={form.expiry} onChange={e => update('expiry', e.target.value)} />
                  </Field>
                  <Field label="期权方向">
                    <NativeSelect value={form.right} onChange={e => update('right', e.target.value)}>
                      <option value="P">Put</option>
                      <option value="C">Call</option>
                    </NativeSelect>
                  </Field>
                  <Field label="行权价">
                    <Input type="number" required min="0.0001" step="any" value={form.strike} onChange={e => update('strike', e.target.valueAsNumber)} />
                  </Field>
                  <Field label="每手股数（乘数）">
                    <Input type="number" required min="1" step="1" value={multiplier} onChange={e => update('multiplier', e.target.valueAsNumber)} />
                  </Field>
                </>
              )}

              {split && (
                <>
                  <Field label="比例 · 分子">
                    <Input type="number" required min="1" step="1" value={form.splitNumerator ?? 2} onChange={e => update('splitNumerator', e.target.valueAsNumber)} />
                  </Field>
                  <Field label="比例 · 分母">
                    <Input type="number" required min="1" step="1" value={form.splitDenominator ?? 1} onChange={e => update('splitDenominator', e.target.valueAsNumber)} />
                  </Field>
                  <Field label="零股现金补偿（USD，选填）" className="sm:col-span-2 lg:col-span-3">
                    <Input type="number" min="0" step="any" placeholder="无零股可留空" value={form.splitCashInLieu ?? ''} onChange={e => update('splitCashInLieu', e.target.value === '' ? undefined : e.target.valueAsNumber)} />
                  </Field>
                </>
              )}

              {hasPrice && (
                <Field label={option ? '每股权利金 / 平仓价' : form.kind === 'dividend' ? '每股分红' : '每股成交价'}>
                  <Input type="number" required min={option ? '0' : '0.0001'} step="any" value={form.price} onChange={e => update('price', e.target.valueAsNumber)} />
                </Field>
              )}
              {hasFees && (
                <Field label="费用总额">
                  <Input type="number" required min="0" step="any" value={form.fees} onChange={e => update('fees', e.target.valueAsNumber)} />
                </Field>
              )}
              {(amountOnly || cashKind) && (
                <Field label={cashKind ? '金额（USD）' : '美元金额'}>
                  <Input type="number" required min={form.kind === 'fee' || cashKind ? '0.0001' : undefined} step="any" value={form.amount} onChange={e => update('amount', e.target.valueAsNumber)} />
                </Field>
              )}
              <Field label="备注" className="sm:col-span-2 lg:col-span-3">
                <Textarea rows={2} value={form.note} onChange={e => update('note', e.target.value)} placeholder="选填" />
              </Field>
            </div>

            {rolling && (
              <fieldset className="space-y-4 rounded-xl border p-4">
                <legend className="px-1 text-sm font-medium">新合约 · 同标的、方向与手数</legend>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="新到期日">
                    <Input type="date" required min={form.date} value={next.expiry} onChange={e => setNext({ ...next, expiry: e.target.value })} />
                  </Field>
                  <Field label="新行权价">
                    <Input type="number" required min="0.0001" step="any" value={next.strike} onChange={e => setNext({ ...next, strike: e.target.valueAsNumber })} />
                  </Field>
                  <Field label="新每股权利金">
                    <Input type="number" required min="0" step="any" value={next.price} onChange={e => setNext({ ...next, price: e.target.valueAsNumber })} />
                  </Field>
                  <Field label="新开仓费用">
                    <Input type="number" required min="0" step="any" value={next.fees} onChange={e => setNext({ ...next, fees: e.target.valueAsNumber })} />
                  </Field>
                </div>
                <p className="text-xs text-muted-foreground">两条交易一起保存；任一条无效时整笔滚动均不入账。</p>
              </fieldset>
            )}

            <div className="entry-preview flex flex-wrap gap-x-10 gap-y-3 rounded-xl border bg-muted/40 px-4 py-3">
              <div className="grid gap-0.5">
                <span className="text-xs text-muted-foreground">{rolling ? '滚动现金净变化' : split ? '零股现金补偿' : '现金净变化'}</span>
                <strong className="num text-sm font-semibold">{money(rolling ? (cash ?? 0) + next.price * multiplier * form.qty - next.fees : cash)}</strong>
              </div>
              {form.kind === 'option_open_short' && (
                <>
                  <div className="grid gap-0.5">
                    <span className="text-xs text-muted-foreground">合约名义金额</span>
                    <strong className="num text-sm font-semibold">{money(collateral)}</strong>
                  </div>
                  <div className="grid gap-0.5">
                    <span className="text-xs text-muted-foreground">预计静态年化</span>
                    <strong className="num text-sm font-semibold">{collateral && days > 0 ? percent((cash ?? 0) / collateral * 365 / days) : '—'}</strong>
                  </div>
                </>
              )}
              {split && (
                <div className="grid gap-0.5">
                  <span className="text-xs text-muted-foreground">拆股比例</span>
                  <strong className="num text-sm font-semibold">{splitNumerator} : {splitDenominator}</strong>
                </div>
              )}
            </div>

            {form.kind === 'option_assign' && (
              <div className="assignment-preview space-y-4 rounded-xl border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-heading text-sm font-semibold">指派预览</h3>
                  <span className="text-xs text-muted-foreground">{assignmentPosition ? `${assignmentPosition.contract} · 当前持股 ${baseShares} 股` : '未匹配当前持仓'}</span>
                </div>
                {assignmentCampaign && assignmentPosition ? (
                  <>
                    <dl className="scenario-values grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                      <Value label={form.right === 'P' ? '买入股数' : '卖出股数'}>{assignedShares} 股</Value>
                      <Value label={form.right === 'P' ? '现金流出' : '现金流入'}>{money(cash)}</Value>
                      <Value label={form.right === 'P' ? '指派后持股' : '剩余持股'}>{form.right === 'P' ? putSharesAfter : callRemainingShares} 股</Value>
                      {form.right === 'P' ? (
                        <>
                          <Value label="指派后成本 A">{money(putCostA)}</Value>
                          <Value label="指派后有效成本 B">{money(putCostB)}</Value>
                          <Value label="含未平仓成本 C′">{money(putCostC)}</Value>
                        </>
                      ) : (
                        <>
                          <Value label="本次股票已实现盈亏" tone={callSharePnl < 0 ? 'negative' : 'positive'}>{money(callSharePnl)}</Value>
                          {callRemainingShares > 0 && (
                            <>
                              <Value label="剩余成本 A">{money(callCostA)}</Value>
                              <Value label="剩余有效成本 B">{money(callCostB)}</Value>
                              <Value label="剩余含未平仓成本 C′">{money(callCostC)}</Value>
                            </>
                          )}
                        </>
                      )}
                    </dl>
                    {form.qty > assignmentPosition.openQty && <p className="negative text-sm text-destructive-foreground" role="alert">当前合约只有 {assignmentPosition.openQty} 手，指派 {form.qty} 手会被拒绝。</p>}
                    {form.right === 'C' && callRemainingShares === 0 && baseShares < assignedShares && <p className="negative text-sm text-destructive-foreground" role="alert">当前持股 {baseShares} 股，不足指派所需的 {assignedShares} 股；保存会被拒绝。</p>}
                    <p className="text-xs leading-relaxed text-muted-foreground">预览按当前战役数据与本次指派手数估算；A 为纯股票成本，B 扣除已落袋净权利金，C′ 再扣除剩余未平仓净权利金。{includeDividendsInCost ? '当前设置将分红计入 B/C′。' : '当前设置不将分红计入 B/C′。'}</p>
                  </>
                ) : (
                  <p className="text-xs leading-relaxed text-muted-foreground">未找到与标的、到期日、行权价和方向匹配的当前持仓。请先用“选择当前持仓”填入合约；仍可保存，但无法预览指派后的股数与成本。</p>
                )}
              </div>
            )}

            {split && (
              <div className="assignment-preview space-y-4 rounded-xl border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-heading text-sm font-semibold">拆股预览</h3>
                  <span className="text-xs text-muted-foreground">{splitCampaign ? `当前持股 ${baseShares} 股` : '该标的没有进行中的战役'}</span>
                </div>
                {splitCampaign ? (
                  <>
                    <dl className="scenario-values grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                      <Value label="拆股后股数">{splitShares} 股</Value>
                      <Value label="零股">{splitHasFraction ? Number(splitExact.toFixed(4)) : 0} 股</Value>
                      <Value label="零股现金补偿">{money(form.splitCashInLieu ?? 0)}</Value>
                      <Value label="拆股后成本 A">{money(splitCostA)}</Value>
                      <Value label="拆股后有效成本 B">{money(splitCostB)}</Value>
                      <Value label="含未平仓成本 C′">{money(splitCostC)}</Value>
                    </dl>
                    {splitHasFraction && form.splitCashInLieu == null && <p className="negative text-sm text-destructive-foreground" role="alert">拆股后产生 {Number(splitExact.toFixed(4))} 股零股，必须填写零股现金补偿（可填 0）。</p>}
                    {!splitHasFraction && (form.splitCashInLieu ?? 0) !== 0 && <p className="negative text-sm text-destructive-foreground" role="alert">按当前比例没有零股，零股补偿应为空或 0；否则保存会被拒绝。</p>}
                    {splitPositions.length > 0 ? (
                      <div className="overflow-hidden rounded-lg border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>未平仓合约</TableHead>
                              <TableHead>新行权价</TableHead>
                              <TableHead>新乘数</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {splitPositions.map(position => (
                              <TableRow key={position.contract}>
                                <TableCell>{position.contract}</TableCell>
                                <TableCell className="num">{position.newStrike}</TableCell>
                                <TableCell className="num">{position.newMultiplier ?? '不是整数，保存会被拒绝'}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : <p className="text-xs text-muted-foreground">当前没有未平仓期权需要调整。</p>}
                  </>
                ) : (
                  <p className="text-xs leading-relaxed text-muted-foreground">该标的当前没有进行中的战役；拆股会作为历史事件记录，不改动任何持仓或成本。</p>
                )}
              </div>
            )}

            {split && <p className="text-xs leading-relaxed text-muted-foreground">例：2 : 1 表示 1 股拆为 2 股，反向拆股用 1 : 10。未平仓期权的行权价与每手股数会自动调整；出现零股时须填写现金补偿（可填 0），系统不保留小数股。</p>}
            {form.kind === 'adjustment' && <p className="text-xs leading-relaxed text-muted-foreground">现金调整计入战役收支，不覆盖持股数或股票成本。账户级入金 / 出金请使用「入金」「出金」类型。</p>}
            {cashKind && <p className="text-xs leading-relaxed text-muted-foreground">入金 / 出金是账户级资金流，不计入任何战役收益。补录历史账本时，先记录一笔期初入金，金额为开始记账时的账户现金。</p>}
            {form.kind === 'option_expire' && <p className="text-xs leading-relaxed text-muted-foreground">确认合约已到期作废后录入；被指派的合约请使用“指派 / 行权”。</p>}

            <div className="form-actions flex flex-wrap items-center gap-3 border-t pt-4">
              {!editing && (
                <label className="check flex items-center gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" className="size-3.5 rounded border-input accent-primary" checked={keep} onChange={e => setKeep(e.target.checked)} />
                  保存后继续录入
                </label>
              )}
              <div className="ms-auto flex gap-2">
                {editing && onCancel && <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>取消修改</Button>}
                <Button type="submit" disabled={busy || submitted}>{submitted ? '已保存' : busy ? '保存中…' : editing ? '保存修改' : '保存交易'}</Button>
              </div>
            </div>
          </form>
        </CardPanel>
      </Card>
    </section>
  );
}
