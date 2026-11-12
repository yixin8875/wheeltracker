import { useEffect, useMemo, useState } from 'react'
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
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="记一笔"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sheet-head">
          <span className="sheet-grip" aria-hidden="true" />
          <h2>记一笔</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="sheet-body">
          <div className="chip-row" role="group" aria-label="期权操作">
            {OPTION_ACTIONS.map((action) => (
              <button
                key={action.kind}
                className={`chip ${kind === action.kind ? 'on' : ''}`}
                onClick={() => setKind(action.kind)}
              >
                {action.label}
              </button>
            ))}
          </div>
          <div className="chip-row" role="group" aria-label="股票与现金">
            {[...SHARE_ACTIONS, ...OTHER_ACTIONS].map((action) => (
              <button
                key={action.kind}
                className={`chip ${kind === action.kind ? 'on' : ''}`}
                onClick={() => setKind(action.kind)}
              >
                {action.label}
              </button>
            ))}
          </div>

          {option && (
            <div className="segmented" role="group" aria-label="期权方向">
              <button
                className={right === 'P' ? 'on' : ''}
                onClick={() => setRight('P')}
              >
                卖 Put
              </button>
              <button
                className={right === 'C' ? 'on' : ''}
                onClick={() => setRight('C')}
              >
                卖 Call
              </button>
            </div>
          )}

          <div className="field-grid">
            {!cash && !amountOnly && (
              <label className="field">
                <span>标的</span>
                <input
                  value={symbol}
                  onChange={(event) => setSymbol(event.target.value.toUpperCase())}
                  placeholder="AAPL"
                  autoCapitalize="characters"
                  inputMode="text"
                />
              </label>
            )}
            <label className="field">
              <span>日期</span>
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>

            {option && (
              <>
                <label className="field">
                  <span>到期日</span>
                  <input
                    type="date"
                    value={expiry}
                    onChange={(event) => setExpiry(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>行权价</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={strike}
                    onChange={(event) => setStrike(event.target.value)}
                    placeholder="150"
                  />
                </label>
              </>
            )}

            {(option || shares) && (
              <>
                <label className="field">
                  <span>{option ? '手数' : '股数'}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={qty}
                    onChange={(event) => setQty(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>{option ? '权利金 / 股' : '成交价'}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={price}
                    onChange={(event) => setPrice(event.target.value)}
                    placeholder="0.00"
                  />
                </label>
                <label className="field">
                  <span>费用</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={fees}
                    onChange={(event) => setFees(event.target.value)}
                  />
                </label>
              </>
            )}

            {kind === 'dividend' && (
              <>
                <label className="field">
                  <span>股数（可空）</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={qty}
                    onChange={(event) => setQty(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>每股分红</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={price}
                    onChange={(event) => setPrice(event.target.value)}
                  />
                </label>
              </>
            )}

            {(cash || amountOnly) && (
              <label className="field">
                <span>金额</span>
                <input
                  type="number"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                />
              </label>
            )}

            <label className="field wide">
              <span>备注</span>
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="可选"
              />
            </label>
          </div>

          {option && kind === 'option_open_short' && (
            <div className="preview">
              <div>
                <span>净权利金</span>
                <strong>{preview.net.toFixed(2)}</strong>
              </div>
              <div>
                <span>占用资金</span>
                <strong>{preview.collateral.toFixed(2)}</strong>
              </div>
            </div>
          )}

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <button className="primary wide" onClick={() => void submit()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </section>
    </div>
  )
}
