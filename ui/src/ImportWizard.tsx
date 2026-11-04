import { useMemo, useState } from 'react';
import { ArrowLeft, Check, Upload } from 'lucide-react';
import { decodeCsvFile } from './csv';
import { api, desktop, labels, money } from './lib';
import type {
  CandidateRow,
  ColumnMapping,
  ImportDateFormat,
  ImportDelimiter,
  ImportField,
  ImportPreview,
  ImportSummary
} from './types';

type Step = 'source' | 'map' | 'review';

const STEPS: { id: Step; label: string }[] = [
  { id: 'source', label: '选择文件' },
  { id: 'map', label: '确认列映射' },
  { id: 'review', label: '逐行确认' }
];

const FIELDS: { id: ImportField; label: string }[] = [
  { id: 'date', label: '交易日期' },
  { id: 'kind', label: '交易类型（规范值）' },
  { id: 'action', label: '方向 / 买卖' },
  { id: 'symbol', label: '标的代码' },
  { id: 'optionSymbol', label: '期权合约代码' },
  { id: 'qty', label: '数量' },
  { id: 'price', label: '价格' },
  { id: 'fees', label: '费用' },
  { id: 'amount', label: '金额' },
  { id: 'expiry', label: '到期日' },
  { id: 'strike', label: '行权价' },
  { id: 'right', label: '看涨 / 看跌' },
  { id: 'note', label: '备注' }
];

const KINDS = ['option_open_short', 'option_close', 'option_expire', 'option_assign', 'shares_buy', 'shares_sell', 'dividend', 'fee', 'adjustment'];

const STATUS: Record<CandidateRow['status'], string> = {
  ok: '可导入',
  warning: '需确认',
  duplicate: '重复',
  error: '错误'
};

const MAPPING_SOURCE = {
  detected: '自动识别',
  saved: '已保存的映射',
  manual: '手动映射'
} as const;

export function ImportWizard({ accountId, onCommitted }: { accountId: string; onCommitted: (message: string) => void }) {
  const [step, setStep] = useState<Step>('source');
  const [paste, setPaste] = useState('');
  const [fileName, setFileName] = useState('');
  const [encoding, setEncoding] = useState('');
  const [encodingWarning, setEncodingWarning] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [selection, setSelection] = useState<Record<number, boolean>>({});
  const [overrides, setOverrides] = useState<Record<number, string>>({});
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const rows = useMemo<CandidateRow[]>(
    () =>
      (preview?.rows ?? []).map(row => {
        const kind = overrides[row.rowNumber];
        return kind && row.event ? { ...row, event: { ...row.event, kind } } : row;
      }),
    [preview, overrides]
  );
  const selectedRows = rows.filter(row => row.event && selection[row.rowNumber]);
  const duplicateSelected = selectedRows.filter(row => row.status === 'duplicate').length;
  const canCommit = desktop && !busy && selectedRows.length > 0 && (duplicateSelected === 0 || allowDuplicates);

  async function runPreview(text: string, nextMapping?: ColumnMapping) {
    if (!desktop) {
      setError('当前是浏览器预览，请通过桌面应用导入本地账本。');
      return;
    }
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const result = await api<ImportPreview>('import_preview', {
        req: { text, mapping: nextMapping ?? undefined, accountId }
      });
      const initial: Record<number, boolean> = {};
      for (const row of result.rows) {
        if (row.event) initial[row.rowNumber] = row.selectedByDefault;
      }
      setPreview(result);
      setMapping(result.mapping);
      setSelection(initial);
      setOverrides({});
      setAllowDuplicates(false);
      setStep('map');
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const decoded = await decodeCsvFile(file);
      setPaste(decoded.text);
      setFileName(file.name);
      setEncoding(decoded.encoding);
      setEncodingWarning(decoded.warning ?? '');
      await runPreview(decoded.text);
    } catch (failure) {
      setError(String(failure));
      setBusy(false);
    }
  }

  function parsePasted() {
    if (!paste.trim()) {
      setError('请先选择文件或粘贴 CSV 文本。');
      return;
    }
    void runPreview(paste);
  }

  function updateField(field: ImportField, raw: string) {
    setMapping(current => {
      if (!current) return current;
      const fields = { ...current.fields };
      if (raw === '') delete fields[field];
      else fields[field] = Number(raw);
      return { ...current, fields };
    });
  }

  function updateMapping(patch: Partial<ColumnMapping>) {
    setMapping(current => (current ? { ...current, ...patch } : current));
  }

  async function saveMapping() {
    if (!preview || !mapping) return;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await api<boolean>('import_save_mapping', { signature: preview.signature, mapping });
      setInfo('列映射已保存；相同表头的文件下次会自动套用。');
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  function selectAll(value: boolean) {
    const next: Record<number, boolean> = {};
    for (const row of rows) {
      if (row.event) next[row.rowNumber] = value;
    }
    setSelection(next);
  }

  async function commit() {
    if (!canCommit || !preview) return;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const summary = await api<ImportSummary>('import_commit', {
        req: {
          accountId,
          origin: fileName || '粘贴文本',
          allowDuplicates,
          rows: selectedRows.map(row => ({ rowNumber: row.rowNumber, event: row.event! }))
        }
      });
      reset();
      onCommitted(`已导入 ${summary.imported} 笔交易，账本已重算。`);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep('source');
    setPaste('');
    setFileName('');
    setEncoding('');
    setEncodingWarning('');
    setPreview(null);
    setMapping(null);
    setSelection({});
    setOverrides({});
    setAllowDuplicates(false);
    setError('');
    setInfo('');
  }

  return (
    <div className="import-page">
      <div className="wizard-steps" aria-label="导入步骤">
        {STEPS.map((item, index) => (
          <span key={item.id} className={step === item.id ? 'active' : ''} aria-current={step === item.id ? 'step' : undefined}>
            {index + 1}. {item.label}
          </span>
        ))}
      </div>

      {!desktop && <div className="alert">浏览器仅预览界面。请启动桌面应用导入本地账本。</div>}
      {error && <div className="alert error" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}
      {info && <div className="alert success" role="status">{info}</div>}

      {step === 'source' && (
        <section className="panel">
          <div className="section-heading">
            <h2>选择 CSV</h2>
            <span className="muted">逗号 / 分号 / 制表符 · UTF-8 或 GB18030 · 最多 5000 行</span>
          </div>
          <label className="file-drop">
            <Upload size={24} />
            <strong>{fileName || '选择 CSV 文件'}</strong>
            <span className="muted">点击选择文件，或把 CSV 内容粘贴到下方</span>
            <input
              type="file"
              accept=".csv,.txt,text/csv"
              disabled={!desktop || busy}
              onChange={event => {
                const file = event.target.files?.[0];
                void chooseFile(file);
                event.target.value = '';
              }}
            />
          </label>
          {(encoding || encodingWarning) && (
            <p className="muted import-meta">
              {encoding && <>编码：{encoding}</>}
              {encodingWarning && <> · {encodingWarning}</>}
            </p>
          )}
          <label className="full import-paste">
            粘贴 CSV 文本
            <textarea
              rows={10}
              value={paste}
              onChange={event => setPaste(event.target.value)}
              placeholder={'日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌\n2026-01-02,卖出开仓,AAPL,1,2.00,1.00,2026-02-20,150,P'}
            />
          </label>
          <div className="form-actions">
            <button onClick={reset} disabled={busy}>清空</button>
            <button className="primary" onClick={parsePasted} disabled={!desktop || busy || !paste.trim()}>
              {busy ? '解析中…' : '解析预览'}
            </button>
          </div>
        </section>
      )}

      {step === 'map' && preview && mapping && (
        <section className="panel">
          <div className="section-heading">
            <h2>确认列映射</h2>
            <span className="muted">{MAPPING_SOURCE[preview.mappingSource]} · 签名 {preview.signature}</span>
          </div>
          {preview.warnings.length > 0 && (
            <div className="alert warning" role="status">
              {preview.warnings.map(warning => <div key={warning}>{warning}</div>)}
            </div>
          )}
          <div className="mapping-grid">
            {FIELDS.map(field => (
              <label key={field.id}>
                {field.label}
                <select
                  value={mapping.fields[field.id] ?? ''}
                  onChange={event => updateField(field.id, event.target.value)}
                >
                  <option value="">不导入</option>
                  {preview.headers.map((header, index) => (
                    <option key={`${field.id}-${index}`} value={index}>{header || `列 ${index + 1}`}</option>
                  ))}
                </select>
              </label>
            ))}
            <label>
              日期格式
              <select
                value={mapping.dateFormat}
                onChange={event => updateMapping({ dateFormat: event.target.value as ImportDateFormat })}
              >
                <option value="auto">自动识别</option>
                <option value="yearMonthDay">年-月-日</option>
                <option value="monthDayYear">月/日/年</option>
                <option value="chinese">中文日期</option>
              </select>
            </label>
            <label>
              分隔符
              <select
                value={mapping.delimiter ?? ''}
                onChange={event => updateMapping({ delimiter: event.target.value === '' ? null : (event.target.value as ImportDelimiter) })}
              >
                <option value="">自动识别</option>
                <option value="comma">逗号</option>
                <option value="semicolon">分号</option>
                <option value="tab">制表符</option>
              </select>
            </label>
            <label>
              首行是表头
              <select
                value={mapping.hasHeader === null ? '' : String(mapping.hasHeader)}
                onChange={event => updateMapping({ hasHeader: event.target.value === '' ? null : event.target.value === 'true' })}
              >
                <option value="">自动判断</option>
                <option value="true">是</option>
                <option value="false">否</option>
              </select>
            </label>
          </div>
          <div className="form-actions">
            <button onClick={() => setStep('source')} disabled={busy}><ArrowLeft size={16} />返回</button>
            <div className="toolbar">
              <button onClick={() => void saveMapping()} disabled={busy}>保存此映射</button>
              <button onClick={() => void runPreview(paste, mapping)} disabled={busy}>重新预览</button>
              <button className="primary" onClick={() => setStep('review')} disabled={busy || !rows.length}>
                下一步 · 逐行确认
              </button>
            </div>
          </div>
        </section>
      )}

      {step === 'review' && preview && (
        <section className="panel">
          <div className="section-heading">
            <h2>逐行确认</h2>
            <span className="muted">
              共 {preview.counts.total} 行 · 可导入 {preview.counts.ok + preview.counts.warning} · 重复 {preview.counts.duplicate} · 错误 {preview.counts.error}
            </span>
          </div>
          <div className="alert warning" role="status">
            提交时会按账本顺序整体校验；任一行不合法，整批都不会入账。
          </div>
          <div className="toolbar import-toolbar">
            <button onClick={() => selectAll(true)} disabled={busy}>全选可导入</button>
            <button onClick={() => selectAll(false)} disabled={busy}>清空选择</button>
            <button onClick={() => setStep('map')} disabled={busy}><ArrowLeft size={16} />返回映射</button>
          </div>
          <div className="table-wrap">
            <table className="import-table">
              <thead>
                <tr>
                  <th>选择</th><th>行</th><th>状态</th><th>类型</th><th>日期</th>
                  <th>标的 / 合约</th><th>数量</th><th>价格</th><th>费用</th><th>说明</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.rowNumber} className={row.status === 'error' ? 'row-error' : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`选择第 ${row.rowNumber} 行`}
                        checked={Boolean(selection[row.rowNumber])}
                        disabled={!row.event}
                        onChange={event => setSelection(current => ({ ...current, [row.rowNumber]: event.target.checked }))}
                      />
                    </td>
                    <td>{row.rowNumber}</td>
                    <td><span className={`row-status ${row.status}`}>{STATUS[row.status]}</span></td>
                    <td>
                      <select
                        aria-label={`第 ${row.rowNumber} 行类型`}
                        value={row.event?.kind ?? ''}
                        disabled={!row.event}
                        onChange={event => setOverrides(current => ({ ...current, [row.rowNumber]: event.target.value }))}
                      >
                        {!row.event && <option value="">—</option>}
                        {KINDS.map(kind => <option key={kind} value={kind}>{labels[kind]}</option>)}
                      </select>
                    </td>
                    <td>{row.event?.date ?? '—'}</td>
                    <td>
                      {row.event ? (
                        <>
                          {row.event.symbol}
                          {row.event.expiry && <small className="muted"> {row.event.expiry} {row.event.strike}{row.event.right}</small>}
                        </>
                      ) : '—'}
                    </td>
                    <td>{row.event?.qty ?? '—'}</td>
                    <td>{row.event ? money(row.event.price) : '—'}</td>
                    <td>{row.event ? money(row.event.fees) : '—'}</td>
                    <td className="import-message">{row.messages.length ? row.messages.join(' ') : row.raw}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {duplicateSelected > 0 && (
            <label className="check import-duplicates">
              <input type="checkbox" checked={allowDuplicates} onChange={event => setAllowDuplicates(event.target.checked)} />
              允许重复导入 {duplicateSelected} 行
            </label>
          )}
          <div className="form-actions">
            <span className="muted">已选择 {selectedRows.length} 行{duplicateSelected > 0 ? `，其中重复 ${duplicateSelected} 行` : ''}</span>
            <button className="primary" onClick={() => void commit()} disabled={!canCommit}>
              <Check size={16} />{busy ? '导入中…' : `确认导入 ${selectedRows.length} 笔`}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
