import { useEffect, useState, type FormEvent } from 'react';
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
    <section className="panel vision-settings">
      <div className="section-heading">
        <h2>AI 截图识别</h2>
        <span className="muted">OpenAI 兼容的 /chat/completions 接口</span>
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert success" role="status">{notice}</div>}
      <form onSubmit={save}>
        <label>
          Base URL
          <input
            type="url"
            value={form.baseUrl}
            disabled={!desktop || !loaded || busy}
            onChange={event => setForm(current => ({ ...current, baseUrl: event.target.value }))}
            placeholder="https://api.openai.com/v1"
          />
        </label>
        <p className="muted vision-hint">
          示例：OpenAI <code>https://api.openai.com/v1</code> · 通义 <code>https://dashscope.aliyuncs.com/compatible-mode/v1</code> ·
          智谱 <code>https://open.bigmodel.cn/api/paas/v4</code> · OpenRouter <code>https://openrouter.ai/api/v1</code>
        </p>
        <label>
          模型
          <input
            type="text"
            value={form.model}
            disabled={!desktop || !loaded || busy}
            onChange={event => setForm(current => ({ ...current, model: event.target.value }))}
            placeholder="gpt-4o"
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            value={apiKey}
            autoComplete="new-password"
            disabled={!desktop || !loaded || busy}
            onChange={event => {
              setApiKey(event.target.value);
              if (event.target.value) setClearKey(false);
            }}
            placeholder={form.hasKey && !clearKey ? `已保存（尾号 ${form.keyHint || '****'}）` : '输入 API Key'}
          />
        </label>
        <div className="vision-key-row">
          <span className="muted">
            {clearKey
              ? '保存后将删除本机保存的 API Key。'
              : form.hasKey
                ? `本机已保存密钥，尾号 ${form.keyHint || '****'}；留空表示不修改。`
                : '尚未保存密钥。'}
          </span>
          {form.hasKey && !clearKey && (
            <button
              type="button"
              disabled={!desktop || busy}
              onClick={() => {
                setApiKey('');
                setClearKey(true);
                setForm(current => ({ ...current, enabled: false }));
              }}
            >
              清除密钥
            </button>
          )}
          {clearKey && (
            <button type="button" disabled={busy} onClick={() => setClearKey(false)}>取消清除</button>
          )}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={!desktop || !loaded || busy}
            onChange={event => setForm(current => ({ ...current, enabled: event.target.checked }))}
          />
          启用 AI 截图识别
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.consent}
            disabled={!desktop || !loaded || busy}
            onChange={event => {
              const consent = event.target.checked;
              setForm(current => ({ ...current, consent, enabled: consent ? current.enabled : false }));
            }}
          />
          我理解截图会发送到上面配置的第三方服务
        </label>
        <div className="alert warning vision-privacy">
          <strong>隐私与密钥</strong>
          <p>截图可能包含账户、持仓与交易记录，会发送到你填写的 Base URL 对应的服务；请只使用你信任的服务。</p>
          <p>
            API Key 以明文保存在本机 SQLite 中，并会随 SQLite 备份（包括自动备份）一起复制；JSON 导出不包含 Key。
            建议使用单独的低额度 Key，重要备份请设置密码。
          </p>
          <p>模型可能看错或漏行；识别结果不会自动入账，必须在导入向导中逐行核对。</p>
        </div>
        <button className="primary" type="submit" disabled={!desktop || !loaded || busy}>
          {busy ? '保存中…' : '保存 AI 识别设置'}
        </button>
      </form>
    </section>
  );
}
