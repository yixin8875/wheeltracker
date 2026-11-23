import { DownloadIcon, RefreshCwIcon, RotateCcwIcon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
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

  return (
    <Card className="about-panel">
      <CardHeader>
        <CardTitle className="text-base">版本与更新</CardTitle>
        <CardDescription>当前版本 v{version ?? '—'}</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-4">
        <p className="text-xs leading-relaxed text-muted-foreground">更新从 GitHub Releases 获取：应用启动时会自动检查一次，也可以在这里手动检查。下载后校验签名，再安装到本机。</p>
        <div className="toolbar flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!desktop || checking || downloading} onClick={() => void update.checkNow()}>
            <RefreshCwIcon className={checking ? 'animate-spin' : ''} />{checking ? '检查中…' : '检查更新'}
          </Button>
          {found && <Button variant="outline" size="sm" onClick={() => void update.install()}><DownloadIcon />下载并安装 v{update.update?.version}</Button>}
          {ready && <Button size="sm" onClick={() => void update.restart()}><RotateCcwIcon />重启应用</Button>}
          <a className="text-button text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" href={RELEASES_URL} target="_blank" rel="noreferrer">查看发布记录</a>
        </div>
        <div className="update-status space-y-2" role="status" aria-live="polite">
          {!desktop && <p className="text-xs text-muted-foreground">浏览器预览不连接更新服务，请在桌面应用中检查更新。</p>}
          {desktop && update.phase === 'idle' && <p className="text-xs text-muted-foreground">尚未检查。点击「检查更新」查询 GitHub Releases。</p>}
          {checking && <p className="text-xs text-muted-foreground">正在查询 GitHub Releases…</p>}
          {update.phase === 'current' && <p className="text-xs text-muted-foreground">已是最新版本 v{version ?? update.update?.currentVersion ?? '—'}{update.checkedAt ? `，检查于 ${update.checkedAt}` : ''}。</p>}
          {found && (
            <Alert variant="warning" role="status">
              发现新版本 <strong>v{update.update?.version}</strong>（当前 v{update.update?.currentVersion ?? version ?? '—'}）。
              {update.update?.body ? <small className="block text-xs text-muted-foreground"> {update.update.body}</small> : null}
            </Alert>
          )}
          {downloading && (
            <Alert role="status">
              正在下载 v{update.update?.version}{percent == null ? '…' : ` · ${percent}%`}
              <progress className="mt-2 block h-1.5 w-full overflow-hidden rounded-full accent-primary" max={100} value={percent ?? 0} />
            </Alert>
          )}
          {ready && <Alert variant="success" role="status">新版本 v{update.update?.version} 已安装，重启应用后生效。</Alert>}
          {failed && <Alert variant="error" role="alert">更新失败：{update.error}</Alert>}
        </div>
        <p className="footnote text-xs leading-relaxed text-muted-foreground">更新检查只读取公开的发布清单，不会上传账本或任何本地数据。</p>
      </CardPanel>
    </Card>
  );
}
