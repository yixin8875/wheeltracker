import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { desktop } from './lib';

export type UpdatePhase = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error';

export type UpdateState = {
  phase: UpdatePhase;
  update: Update | null;
  downloaded: number;
  total: number;
  error: string;
  checkedAt: string | null;
  /** Manual checks surface failures; the startup check stays silent. */
  checkNow: () => Promise<void>;
  install: () => Promise<void>;
  restart: () => Promise<void>;
};

const UpdateContext = createContext<UpdateState | null>(null);

function stamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/**
 * One updater state shared by the startup banner and the settings panel.
 * Checking twice would hold two plugin resources and could race on install.
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [update, setUpdate] = useState<Update | null>(null);
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const current = useRef<Update | null>(null);
  const busy = useRef(false);
  const started = useRef(false);

  const adopt = useCallback((found: Update | null) => {
    const previous = current.current;
    current.current = found;
    setUpdate(found);
    // Release the plugin resource held by an earlier check result.
    if (previous && previous !== found) void previous.close().catch(() => undefined);
  }, []);

  const runCheck = useCallback(async (manual: boolean) => {
    if (!desktop || busy.current) return;
    busy.current = true;
    setPhase('checking');
    setError('');
    try {
      const found = await check();
      if (found) { adopt(found); setPhase('available'); }
      else { adopt(null); setPhase('current'); }
      setCheckedAt(stamp());
    } catch (failure) {
      setError(String(failure));
      // The startup check runs before the user is looking; keep the UI quiet.
      setPhase(manual ? 'error' : 'idle');
    } finally {
      busy.current = false;
    }
  }, [adopt]);

  // StrictMode mounts effects twice in development; ask the endpoint once.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void runCheck(false);
  }, [runCheck]);

  // A reopened window may unmount while the plugin still holds an update.
  useEffect(() => () => { void current.current?.close().catch(() => undefined); }, []);

  const install = useCallback(async () => {
    if (!current.current) return;
    setPhase('downloading');
    setError('');
    setDownloaded(0);
    setTotal(0);
    try {
      await current.current.downloadAndInstall(event => {
        if (event.event === 'Started') setTotal(event.data.contentLength ?? 0);
        if (event.event === 'Progress') setDownloaded(value => value + event.data.chunkLength);
        if (event.event === 'Finished') setPhase('ready');
      });
      setPhase('ready');
    } catch (failure) {
      setError(String(failure));
      setPhase('error');
    }
  }, []);

  const restart = useCallback(async () => {
    if (!desktop) return;
    try { await relaunch(); }
    catch (failure) { setError(String(failure)); setPhase('error'); }
  }, []);

  return <UpdateContext.Provider value={{
    phase, update, downloaded, total, error, checkedAt,
    checkNow: () => runCheck(true), install, restart,
  }}>{children}</UpdateContext.Provider>;
}

export function useUpdate(): UpdateState {
  const state = useContext(UpdateContext);
  if (!state) throw new Error('useUpdate 必须在 UpdateProvider 内使用。');
  return state;
}

export function updatePercent(downloaded: number, total: number): number | null {
  return total > 0 ? Math.min(100, Math.round(downloaded / total * 100)) : null;
}
