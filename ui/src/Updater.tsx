import { useEffect, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { desktop } from './lib';

type Phase = 'idle' | 'downloading' | 'ready' | 'error';

export function Updater() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    check()
      .then(found => {
        if (!cancelled && found) setUpdate(found);
      })
      .catch(() => {
        // Offline or endpoint unavailable: stay silent and try again next start.
      });
    return () => { cancelled = true; };
  }, []);

  if (!update) return null;

  const install = async () => {
    setPhase('downloading');
    setError('');
    setDownloaded(0);
    setTotal(0);
    try {
      await update.downloadAndInstall(event => {
        if (event.event === 'Started') setTotal(event.data.contentLength ?? 0);
        if (event.event === 'Progress') setDownloaded(value => value + event.data.chunkLength);
        if (event.event === 'Finished') setPhase('ready');
      });
      setPhase('ready');
    } catch (reason) {
      setError(String(reason));
      setPhase('error');
    }
  };

  const percent = total > 0 ? Math.min(100, Math.round(downloaded / total * 100)) : null;

  return <div className={`alert update-banner ${phase === 'error' ? 'error' : ''}`} role="status">
    {phase === 'error'
      ? <span>更新 {update.version} 安装失败：{error}</span>
      : phase === 'ready'
        ? <span>新版本 {update.version} 已安装，重启应用后生效。</span>
        : phase === 'downloading'
          ? <span>正在下载 {update.version}{percent == null ? '…' : ` · ${percent}%`}<progress max={100} value={percent ?? 0}/></span>
          : <span>发现新版本 <strong>v{update.version}</strong>（当前 v{update.currentVersion}）。</span>}
    <div className="toolbar">
      {phase === 'ready'
        ? <button className="primary" onClick={() => void relaunch()}>重启应用</button>
        : <button className="primary" disabled={phase === 'downloading'} onClick={() => void install()}>{phase === 'downloading' ? '下载中…' : phase === 'error' ? '重试安装' : '下载并安装'}</button>}
    </div>
  </div>;
}
