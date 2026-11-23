import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { updatePercent, useUpdate } from './update';

/**
 * Startup banner. The check itself lives in UpdateProvider so the settings
 * panel can share the same result instead of hitting the endpoint twice.
 */
export function Updater() {
  const { phase, update, downloaded, total, error, install, restart } = useUpdate();

  // Stay quiet for idle/checking/up-to-date: the banner is only for news.
  if (!update || phase === 'idle' || phase === 'checking' || phase === 'current') return null;
  const percent = updatePercent(downloaded, total);

  return (
    <Alert variant={phase === 'error' ? 'error' : phase === 'ready' ? 'success' : 'info'} role="status" className={`update-banner ${phase === 'error' ? 'error' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-sm">
          {phase === 'error'
            ? <span>更新 {update.version} 安装失败：{error}</span>
            : phase === 'ready'
              ? <span>新版本 {update.version} 已安装，重启应用后生效。</span>
              : phase === 'downloading'
                ? <span>正在下载 {update.version}{percent == null ? '…' : ` · ${percent}%`}<progress className="ms-2 inline-block h-1.5 w-32 align-middle accent-primary" max={100} value={percent ?? 0} /></span>
                : <span>发现新版本 <strong>v{update.version}</strong>（当前 v{update.currentVersion}）。</span>}
        </span>
        <div className="toolbar flex shrink-0 gap-2">
          {phase === 'ready'
            ? <Button size="xs" onClick={() => void restart()}>重启应用</Button>
            : <Button size="xs" disabled={phase === 'downloading'} onClick={() => void install()}>{phase === 'downloading' ? '下载中…' : phase === 'error' ? '重试安装' : '下载并安装'}</Button>}
        </div>
      </div>
    </Alert>
  );
}
