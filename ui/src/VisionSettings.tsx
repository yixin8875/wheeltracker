import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, desktop } from './lib';
import type { VisionSettings as VisionSettingsData } from './types';

const EMPTY: VisionSettingsData = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  hasKey: false,
  keyHint: '',
  enabled: false,
  consent: false
};

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
      <span>{label}</span>
      {children}
      {hint ? <span className="font-normal leading-relaxed">{hint}</span> : null}
    </label>
  );
}

export function VisionSettings() {
  const [form, setForm] = useState<VisionSettingsData>(EMPTY);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [loaded, setLoaded] = useState(!desktop);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    api<VisionSettingsData>('get_vision_settings')
      .then(value => {
        if (cancelled) return;
        setForm(value);
        setLoaded(true);
      })
      .catch(failure => {
        if (cancelled) return;
        setError(String(failure));
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !loaded) return;
    const keyPending = Boolean(apiKey.trim());
    if (form.enabled && !form.consent) {
      setError('启用前请先阅读并勾选隐私说明。');
      return;
    }
    if (form.enabled && !form.hasKey && !keyPending) {
      setError('启用前请先保存 API Key。');
      return;
    }
    if (form.enabled && clearKey && !keyPending) {
      setError('不能一边清除密钥一边启用 AI 截图识别。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<VisionSettingsData>('set_vision_settings', {
        req: {
          baseUrl: form.baseUrl.trim(),
          model: form.model.trim(),
          apiKey: clearKey ? '' : keyPending ? apiKey.trim() : undefined,
          enabled: form.enabled,
          consent: form.consent
        }
      });
      setForm(result);
      setApiKey('');
      setClearKey(false);
      setNotice('AI 识别设置已保存。');
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="vision-settings">
      <CardHeader>
        <CardTitle className="text-base">识别服务</CardTitle>
        <CardDescription>OpenAI 兼容的 /chat/completions 接口</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-4">
        {error && <Alert variant="error" role="alert" className="alert error">{error}</Alert>}
        {notice && <Alert variant="success" role="status" className="alert success">{notice}</Alert>}
        <form onSubmit={save} className="space-y-4">
          <Field
            label="Base URL"
            hint={<>示例：OpenAI <code className="rounded bg-muted px-1">https://api.openai.com/v1</code> · 通义 <code className="rounded bg-muted px-1">https://dashscope.aliyuncs.com/compatible-mode/v1</code> · 智谱 <code className="rounded bg-muted px-1">https://open.bigmodel.cn/api/paas/v4</code> · OpenRouter <code className="rounded bg-muted px-1">https://openrouter.ai/api/v1</code></>}
          >
            <Input
              type="url"
              value={form.baseUrl}
              disabled={!desktop || !loaded || busy}
              onChange={event => setForm(current => ({ ...current, baseUrl: event.target.value }))}
              placeholder="https://api.openai.com/v1"
            />
          </Field>
          <Field label="模型">
            <Input
              type="text"
              className="max-w-xs"
              value={form.model}
              disabled={!desktop || !loaded || busy}
              onChange={event => setForm(current => ({ ...current, model: event.target.value }))}
              placeholder="gpt-4o"
            />
          </Field>
          <Field label="API Key">
            <Input
              type="password"
              className="max-w-md"
              value={apiKey}
              autoComplete="new-password"
              disabled={!desktop || !loaded || busy}
              onChange={event => {
                setApiKey(event.target.value);
                if (event.target.value) setClearKey(false);
              }}
              placeholder={form.hasKey && !clearKey ? `已保存（尾号 ${form.keyHint || '****'}）` : '输入 API Key'}
            />
          </Field>
          <div className="vision-key-row flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>
              {clearKey
                ? '保存后将删除本机保存的 API Key。'
                : form.hasKey
                  ? `本机已保存密钥，尾号 ${form.keyHint || '****'}；留空表示不修改。`
                  : '尚未保存密钥。'}
            </span>
            {form.hasKey && !clearKey && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={!desktop || busy}
                onClick={() => {
                  setApiKey('');
                  setClearKey(true);
                  setForm(current => ({ ...current, enabled: false }));
                }}
              >
                清除密钥
              </Button>
            )}
            {clearKey && (
              <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => setClearKey(false)}>取消清除</Button>
            )}
          </div>
          <label className="check flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-3.5 rounded border-input accent-primary"
              checked={form.enabled}
              disabled={!desktop || !loaded || busy}
              onChange={event => setForm(current => ({ ...current, enabled: event.target.checked }))}
            />
            启用 AI 截图识别
          </label>
          <label className="check flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-3.5 rounded border-input accent-primary"
              checked={form.consent}
              disabled={!desktop || !loaded || busy}
              onChange={event => {
                const consent = event.target.checked;
                setForm(current => ({ ...current, consent, enabled: consent ? current.enabled : false }));
              }}
            />
            我理解截图会发送到上面配置的第三方服务
          </label>
          <Alert variant="warning" className="vision-privacy alert warning">
            <div className="space-y-1.5">
              <strong className="block text-sm font-medium">隐私与密钥</strong>
              <p className="text-xs leading-relaxed">截图可能包含账户、持仓与交易记录，会发送到你填写的 Base URL 对应的服务；请只使用你信任的服务。</p>
              <p className="text-xs leading-relaxed">
                API Key 以明文保存在本机 SQLite 中，并会随 SQLite 备份（包括自动备份）一起复制；JSON 导出不包含 Key。
                建议使用单独的低额度 Key，重要备份请设置密码。
              </p>
              <p className="text-xs leading-relaxed">模型可能看错或漏行；识别结果不会自动入账，必须在导入向导中逐行核对。</p>
            </div>
          </Alert>
          <Button type="submit" disabled={!desktop || !loaded || busy}>
            {busy ? '保存中…' : '保存 AI 识别设置'}
          </Button>
        </form>
      </CardPanel>
    </Card>
  );
}
