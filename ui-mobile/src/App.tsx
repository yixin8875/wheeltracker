import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

interface CampaignCard {
  symbol: string
  shares: number
  costA: number | null
  costB: number | null
  costC: number | null
  premiumRealized: number
  premiumOpen: number
  status: string
}

interface ProbeView {
  dbPath: string
  sqliteVersion: string
  eventCount: number
  campaigns: CampaignCard[]
  generatedAt: string
  note: string
}

function hasTauri() {
  return '__TAURI_INTERNALS__' in window
}

function money(value: number | null, digits = 2) {
  if (value === null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export default function App() {
  const [probe, setProbe] = useState<ProbeView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!hasTauri()) {
      setError('浏览器预览不读取账本，请在 Android 应用或 Tauri 桌面环境中打开。')
      return
    }
    setBusy(true)
    setError('')
    try {
      setProbe(await invoke<ProbeView>('mobile_probe'))
    } catch (failure) {
      setError(String(failure))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <main className="screen">
      <header className="topbar">
        <div>
          <p className="eyebrow">M0.5 · Android Spike</p>
          <h1>Wheel Tracker</h1>
        </div>
        <button className="refresh" onClick={() => void load()} disabled={busy}>
          {busy ? '读取中…' : '重新读取'}
        </button>
      </header>

      <section className="hero">
        <p className="hero-label">探针状态</p>
        <p className="hero-value">{probe ? `${probe.eventCount} 条事件` : '等待 Rust 返回'}</p>
        <p className="hero-note">
          {probe
            ? `SQLite ${probe.sqliteVersion} · wheel-core 重放成功`
            : '正在打开 SQLite 并重放 wheel-core 事件'}
        </p>
      </section>

      {error && (
        <div className="alert" role="alert">
          <strong>读取失败</strong>
          <span>{error}</span>
        </div>
      )}

      {probe && (
        <>
          <section className="panel">
            <div className="panel-title">
              <h2>战役</h2>
              <span className="badge">{probe.campaigns.length}</span>
            </div>
            {probe.campaigns.map((campaign) => (
              <article className="campaign" key={`${campaign.symbol}-${campaign.status}`}>
                <div className="campaign-head">
                  <strong>{campaign.symbol}</strong>
                  <span className={`status ${campaign.status.toLowerCase()}`}>
                    {campaign.status === 'Active' ? '进行中' : campaign.status}
                  </span>
                </div>
                <div className="metrics">
                  <div>
                    <span>持股</span>
                    <strong>{campaign.shares}</strong>
                  </div>
                  <div>
                    <span>成本 B</span>
                    <strong>{money(campaign.costB)}</strong>
                  </div>
                  <div>
                    <span>成本 C′</span>
                    <strong>{money(campaign.costC)}</strong>
                  </div>
                </div>
                <div className="premium">
                  <span>已落袋 {money(campaign.premiumRealized)}</span>
                  <span>未平仓 {money(campaign.premiumOpen)}</span>
                </div>
              </article>
            ))}
          </section>

          <section className="panel meta">
            <h2>运行环境</h2>
            <dl>
              <div>
                <dt>数据库</dt>
                <dd>{probe.dbPath}</dd>
              </div>
              <div>
                <dt>读取时间</dt>
                <dd>{probe.generatedAt}</dd>
              </div>
            </dl>
            <p className="note">{probe.note}</p>
          </section>
        </>
      )}

      <footer className="footer">
        M0.5 只验证 Tauri / SQLite / Rust 引擎 / 手机布局，不包含真实账本与写入。
      </footer>
    </main>
  )
}
