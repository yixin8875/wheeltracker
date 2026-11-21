import { Download, RefreshCw, RotateCcw } from 'lucide-react';
import { desktop } from './lib';
import { updatePercent, useUpdate } from './update';

const RELEASES_URL = 'https://github.com/yixin8875/wheeltracker/releases';

export function AboutPanel({ version }: { version: string | null }) {
  const update = useUpdate();
  const percent = updatePercent(update.downloaded, update.total);
  const checking = update.phase === 'checking';
  const downloading = update.phase === 'downloading';
  const found = update.phase === 'available';
  const ready = update.phase === 'ready';
  const failed = update.phase === 'error';

  return <>
    <section className="panel">
      <div className="section-heading"><h2>版本与更新</h2><span className="muted">当前版本 v{version ?? '—'}</span></div>
      <p className="muted">更新从 GitHub Releases 获取：应用启动时会自动检查一次，也可以在这里手动检查。下载后校验签名，再安装到本机。</p>
      <div className="toolbar">
        <button className="primary" disabled={!desktop || checking || downloading} onClick={() => void update.checkNow()}>
          <RefreshCw size={16} className={checking ? 'spinning' : ''}/>{checking ? '检查中…' : '检查更新'}
        </button>
        {found && <button onClick={() => void update.install()}><Download size={16}/>下载并安装 v{update.update?.version}</button>}
        {ready && <button className="primary" onClick={() => void update.restart()}><RotateCcw size={16}/>重启应用</button>}
        <a className="text-button" href={RELEASES_URL} target="_blank" rel="noreferrer">查看发布记录</a>
      </div>
      <div className="update-status" role="status" aria-live="polite">
        {!desktop && <p className="muted">浏览器预览不连接更新服务，请在桌面应用中检查更新。</p>}
        {desktop && update.phase === 'idle' && <p className="muted">尚未检查。点击「检查更新」查询 GitHub Releases。</p>}
        {checking && <p className="muted">正在查询 GitHub Releases…</p>}
        {update.phase === 'current' && <p className="muted">已是最新版本 v{version ?? update.update?.currentVersion ?? '—'}{update.checkedAt ? `，检查于 ${update.checkedAt}` : ''}。</p>}
        {found && <div className="alert warning" role="status">
          发现新版本 <strong>v{update.update?.version}</strong>（当前 v{update.update?.currentVersion ?? version ?? '—'}）。
          {update.update?.body ? <small className="muted"> {update.update.body}</small> : null}
        </div>}
        {downloading && <div className="alert" role="status">
          正在下载 v{update.update?.version}{percent == null ? '…' : ` · ${percent}%`}<progress max={100} value={percent ?? 0}/>
        </div>}
        {ready && <div className="alert success" role="status">新版本 v{update.update?.version} 已安装，重启应用后生效。</div>}
        {failed && <div className="alert error" role="alert">更新失败：{update.error}</div>}
      </div>
      <p className="footnote">更新检查只读取公开的发布清单，不会上传账本或任何本地数据。</p>
    </section>
  </>;
}
