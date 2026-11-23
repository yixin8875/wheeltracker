import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { XIcon } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  addEvent,
  type EntryKind,
  type NewEventReq,
  type Position,
} from './api'

interface EntryPreset {
  kind: EntryKind
  position?: Position
}

interface Props {
  today: string
  accountId: string
  preset?: EntryPreset
  onClose: () => void
  onSaved: (message: string) => void
}

const OPTION_ACTIONS: { kind: EntryKind; label: string }[] = [
  { kind: 'option_open_short', label: '卖出开仓' },
  { kind: 'option_close', label: '平仓' },
  { kind: 'option_expire', label: '到期作废' },
  { kind: 'option_assign', label: '被指派' },
]

const SHARE_ACTIONS: { kind: EntryKind; label: string }[] = [
  { kind: 'shares_buy', label: '买入股票' },
  { kind: 'shares_sell', label: '卖出股票' },
]

const OTHER_ACTIONS: { kind: EntryKind; label: string }[] = [
  { kind: 'dividend', label: '分红' },
  { kind: 'fee', label: '费用' },
  { kind: 'adjustment', label: '调整' },
  { kind: 'cash_deposit', label: '入金' },
  { kind: 'cash_withdrawal', label: '出金' },
]

const KIND_LABEL: Record<string, string> = Object.fromEntries(
  [...OPTION_ACTIONS, ...SHARE_ACTIONS, ...OTHER_ACTIONS].map((action) => [
    action.kind,
    action.label,
  ]),
)

const FIELD_INPUT = 'h-10 [&_input]:h-full [&_input]:leading-10'

function isOption(kind: EntryKind) {
  return kind.startsWith('option_')
}

function isCash(kind: EntryKind) {
  return kind === 'cash_deposit' || kind === 'cash_withdrawal'
}

function number(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function Field({
  label,
  wide,
  children,
}: {
  label: string
  wide?: boolean
  children: ReactNode
}) {
  return (
    <label
      className={cn(
        'flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground',
        wide && 'col-span-2',
      )}
    >
      <span>{label}</span>
      {children}
    </label>
  )
}

function ChipButton({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: ReactNode
  onClick: () => void
}) {
  return (
    <Button
      size="sm"
      variant={active ? 'secondary' : 'outline'}
      aria-pressed={active}
      onClick={onClick}
      className="rounded-full"
    >
      {children}
    </Button>
  )
}

export default function EntrySheet({
  today,
  accountId,
  preset,
  onClose,
  onSaved,
}: Props) {
  const [kind, setKind] = useState<EntryKind>(preset?.kind ?? 'option_open_short')
  const [right, setRight] = useState<'P' | 'C'>(
    (preset?.position?.right as 'P' | 'C') ?? 'P',
  )
  const [symbol, setSymbol] = useState(preset?.position?.symbol ?? '')
  const [date, setDate] = useState(today)
  const [qty, setQty] = useState(preset?.position ? String(preset.position.openQty) : '1')
  const [price, setPrice] = useState('')
  const [fees, setFees] = useState('0')
  const [amount, setAmount] = useState('')
  const [expiry, setExpiry] = useState(preset?.position?.expiry ?? '')
  const [strike, setStrike] = useState(
    preset?.position ? String(preset.position.strike) : '',
  )
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const option = isOption(kind)
  const cash = isCash(kind)
  const amountOnly = kind === 'fee' || kind === 'adjustment'
  const shares = kind === 'shares_buy' || kind === 'shares_sell'

  const preview = useMemo(() => {
    const multiplier = 100
    const gross = number(price) * number(qty) * multiplier
    const net = gross - number(fees)
    const collateral =
      kind === 'option_open_short' ? number(strike) * multiplier * number(qty) : 0
    return { net, collateral }
  }, [kind, price, qty, fees, strike])

  const submit = async () => {
    setError('')
    if (!cash && !amountOnly && !symbol.trim()) {
      setError('请填写标的代码。')
      return
    }
    const req: NewEventReq = {
      accountId,
      date,
      kind,
      symbol: cash ? '' : symbol.trim().toUpperCase(),
      qty: option || shares || kind === 'dividend' ? Math.trunc(number(qty)) : 0,
      price: option || shares || kind === 'dividend' ? number(price) : 0,
      fees: option || shares ? number(fees) : 0,
      amount: cash || amountOnly ? number(amount) : 0,
      expiry: option ? expiry : null,
      strike: option ? number(strike) : null,
      right: option ? right : null,
      multiplier: null,
      note: note.trim() || null,
    }
    setBusy(true)
    try {
      await addEvent(req)
      onSaved(`${KIND_LABEL[kind] ?? kind}已保存`)
    } catch (failure) {
      setError(String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex animate-in items-end justify-center bg-black/40 backdrop-blur-sm duration-150 fade-in-0"
      onClick={onClose}
      role="presentation"
    >
      <section
        className="max-h-[92dvh] w-full max-w-[30rem] animate-in overflow-y-auto rounded-t-2xl border bg-background p-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-xl duration-300 fade-in-0 slide-in-from-bottom-6"
        role="dialog"
        aria-modal="true"
        aria-label="记一笔"
        onClick={(event) => event.stopPropagation()}
      >
        <span
          aria-hidden="true"
          className="mx-auto mb-1 block h-1 w-9 rounded-full bg-border"
        />
        <header className="sticky top-0 z-10 -mx-4 flex items-center justify-between gap-3 border-b bg-background px-4 py-2.5">
          <h2 className="font-heading text-base font-semibold">记一笔</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭">
            <XIcon />
          </Button>
        </header>

        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="期权操作">
            {OPTION_ACTIONS.map((action) => (
              <ChipButton
                key={action.kind}
                active={kind === action.kind}
                onClick={() => setKind(action.kind)}
              >
                {action.label}
              </ChipButton>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="股票与现金">
            {[...SHARE_ACTIONS, ...OTHER_ACTIONS].map((action) => (
              <ChipButton
                key={action.kind}
                active={kind === action.kind}
                onClick={() => setKind(action.kind)}
              >
                {action.label}
              </ChipButton>
            ))}
          </div>

          {option && (
            <div
              className="inline-flex w-full rounded-lg border bg-muted/40 p-0.5"
              role="group"
              aria-label="期权方向"
            >
              <Button
                size="sm"
                variant={right === 'P' ? 'secondary' : 'ghost'}
                aria-pressed={right === 'P'}
                className="flex-1"
                onClick={() => setRight('P')}
              >
                卖 Put
              </Button>
              <Button
                size="sm"
                variant={right === 'C' ? 'secondary' : 'ghost'}
                aria-pressed={right === 'C'}
                className="flex-1"
                onClick={() => setRight('C')}
              >
                卖 Call
              </Button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {!cash && !amountOnly && (
              <Field label="标的" wide>
                <Input
                  className={FIELD_INPUT}
                  value={symbol}
                  onChange={(event) => setSymbol(event.target.value.toUpperCase())}
                  placeholder="AAPL"
                  autoCapitalize="characters"
                  inputMode="text"
                />
              </Field>
            )}
            <Field label="日期">
              <Input
                className={FIELD_INPUT}
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </Field>

            {option && (
              <>
                <Field label="到期日">
                  <Input
                    className={FIELD_INPUT}
                    type="date"
                    value={expiry}
                    onChange={(event) => setExpiry(event.target.value)}
                  />
                </Field>
                <Field label="行权价">
                  <Input
                    className={FIELD_INPUT}
                    type="number"
                    inputMode="decimal"
                    value={strike}
                    onChange={(event) => setStrike(event.target.value)}
                    placeholder="150"
                  />
                </Field>
              </>
            )}

            {(option || shares) && (
              <>
                <Field label={option ? '手数' : '股数'}>
                  <Input
                    className={FIELD_INPUT}
                    type="number"
                    inputMode="numeric"
                    value={qty}
                    onChange={(event) => setQty(event.target.value)}
                  />
                </Field>
                <Field label={option ? '权利金 / 股' : '成交价'}>
                  <Input
                    className={FIELD_INPUT}
                    type="number"
                    inputMode="decimal"
                    value={price}
                    onChange={(event) => setPrice(event.target.value)}
                    placeholder="0.00"
                  />
                </Field>
                <Field label="费用">
                  <Input
                    className={FIELD_INPUT}
                    type="number"
                    inputMode="decimal"
                    value={fees}
                    onChange={(event) => setFees(event.target.value)}
                  />
                </Field>
              </>
            )}

            {kind === 'dividend' && (
              <>
                <Field label="股数（可空）">
                  <Input
                    className={FIELD_INPUT}
                    type="number"
                    inputMode="numeric"
                    value={qty}
                    onChange={(event) => setQty(event.target.value)}
                  />
                </Field>
                <Field label="每股分红">
                  <Input
                    className={FIELD_INPUT}
                    type="number"
                    inputMode="decimal"
                    value={price}
                    onChange={(event) => setPrice(event.target.value)}
                  />
                </Field>
              </>
            )}

            {(cash || amountOnly) && (
              <Field label="金额">
                <Input
                  className={FIELD_INPUT}
                  type="number"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                />
              </Field>
            )}

            <Field label="备注" wide>
              <Input
                className={FIELD_INPUT}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="可选"
              />
            </Field>
          </div>

          {option && kind === 'option_open_short' && (
            <div className="grid grid-cols-2 gap-3 rounded-xl border bg-muted/40 px-3.5 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[11px] text-muted-foreground">净权利金</span>
                <strong className="num text-base font-medium">{preview.net.toFixed(2)}</strong>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[11px] text-muted-foreground">占用资金</span>
                <strong className="num text-base font-medium">
                  {preview.collateral.toFixed(2)}
                </strong>
              </div>
            </div>
          )}

          {error && (
            <Alert variant="error" role="alert">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}

          <Button
            size="xl"
            className="w-full"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? '保存中…' : '保存'}
          </Button>
        </div>
      </section>
    </div>
  )
}
