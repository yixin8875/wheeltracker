import { useEffect, useMemo, useState, type ClipboardEvent, type ReactNode } from 'react';
import { ArrowLeftIcon, CheckIcon, ClipboardIcon, RefreshCwIcon, UploadIcon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/native-select';
import { cn } from '@/lib/utils';
import { decodeCsvFile } from './csv';
import { api, desktop, labels } from './lib';
import type {
  CandidateEvent,
  CandidateRow,
  ColumnMapping,
  ImportBatch,
  ImportDateFormat,
  ImportDelimiter,
  ImportField,
  ImportPreview,
  ImportSummary
} from './types';

type Step = 'source' | 'map' | 'review';
type Mode = 'csv' | 'vision';

const MODES: { id: Mode; label: string }[] = [
  { id: 'csv', label: 'CSV 文件' },
  { id: 'vision', label: 'AI 截图' }
];

const STEPS: { id: Step; label: string }[] = [
  { id: 'source', label: '选择文件' },
  { id: 'map', label: '确认列映射' },
  { id: 'review', label: '逐行确认' }
];

const VISION_STEPS: { id: Step; label: string }[] = [
  { id: 'source', label: '选择截图' },
  { id: 'review', label: '逐行确认' }
];

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif'
};

function imageMime(file: File) {
  if (Object.values(IMAGE_MIME).includes(file.type)) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME[extension] ?? '';
}

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('无法读取图片文件。'));
    reader.readAsDataURL(file);
  });
}

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
  { id: 'multiplier', label: '每手股数 / 乘数' },
  { id: 'note', label: '备注' }
];

const KINDS = ['option_open_short', 'option_close', 'option_expire', 'option_assign', 'shares_buy', 'shares_sell', 'dividend', 'fee', 'interest', 'adjustment', 'cash_deposit', 'cash_withdrawal'];
const OPTION_KINDS = new Set(['option_open_short', 'option_close', 'option_expire', 'option_assign']);
const CASH_KINDS = new Set(['cash_deposit', 'cash_withdrawal']);

const STATUS: Record<CandidateRow['status'], string> = {
  ok: '可导入',
  warning: '需确认',
  duplicate: '重复',
  error: '错误'
};

const STATUS_TONE: Record<CandidateRow['status'], 'success' | 'warning' | 'secondary' | 'destructive'> = {
  ok: 'success',
  warning: 'warning',
  duplicate: 'secondary',
  error: 'destructive'
};

const MAPPING_SOURCE = {
  detected: '自动识别',
  saved: '已保存的映射',
  manual: '手动映射',
  vision: 'AI 截图'
} as const;

/** Label wrapper used across the wizard forms. */
function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={cn('grid gap-1.5 text-xs font-medium text-muted-foreground', className)}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function ImportWizard({ accountId, onCommitted, onOpenVisionSettings }: {
  accountId: string;
  onCommitted: (message: string) => void;
  onOpenVisionSettings?: () => void;
}) {
  const [mode, setMode] = useState<Mode>('csv');
  const [step, setStep] = useState<Step>('source');
  const [paste, setPaste] = useState('');
  const [fileName, setFileName] = useState('');
  const [encoding, setEncoding] = useState('');
  const [encodingWarning, setEncodingWarning] = useState('');
  const [imageName, setImageName] = useState('');
  const [origin, setOrigin] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [selection, setSelection] = useState<Record<number, boolean>>({});
  const [edits, setEdits] = useState<Record<number, Partial<CandidateEvent>>>({});
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [pendingImage, setPendingImage] = useState<File | null>(null);
  const [pendingImageUrl, setPendingImageUrl] = useState('');
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [batchError, setBatchError] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [pendingBatch, setPendingBatch] = useState<ImportBatch | null>(null);

  useEffect(() => () => {
    if (pendingImageUrl) URL.revokeObjectURL(pendingImageUrl);
  }, [pendingImageUrl]);

  useEffect(() => {
    reset();
    void loadBatches();
    // The account switch replaces the whole import context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const rows = useMemo<CandidateRow[]>(
    () =>
      (preview?.rows ?? []).map(row => {
        const edit = edits[row.rowNumber];
        if (!edit || !row.event) return row;
        return {
          ...row,
          status: 'warning' as const,
          messages: ['已手动修改，提交时会重新校验。'],
          event: { ...row.event, ...edit },
        };
      }),
    [preview, edits]
  );
  const selectedRows = rows.filter(row => row.event && selection[row.rowNumber]);
  const duplicateSelected = selectedRows.filter(row => row.status === 'duplicate').length;
  const canCommit = desktop && !busy && selectedRows.length > 0 && (duplicateSelected === 0 || allowDuplicates);

  function applyPreview(result: ImportPreview, nextStep: Step) {
    const initial: Record<number, boolean> = {};
    for (const row of result.rows) {
      if (row.event) initial[row.rowNumber] = row.selectedByDefault;
    }
    setPreview(result);
    setMapping(result.mapping);
    setSelection(initial);
    setEdits({});
    setAllowDuplicates(false);
    setStep(nextStep);
  }

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
      applyPreview(result, 'map');
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

  function clearPendingImage() {
    setPendingImage(null);
    setPendingImageUrl('');
    setImageName('');
  }

  function stageImage(file: File | undefined) {
    if (!file) return;
    if (!desktop) {
      setError('当前是浏览器预览，请通过桌面应用导入本地账本。');
      return;
    }
    const mime = imageMime(file);
    if (!mime) {
      setError('仅支持 PNG、JPEG、WebP 或 GIF 截图。');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('截图超过 5 MB 上限，请裁剪或压缩后再试。');
      return;
    }
    setError('');
    setInfo('');
    setPendingImage(file);
    setPendingImageUrl(URL.createObjectURL(file));
    setImageName(file.name);
  }

  async function uploadPendingImage() {
    if (!pendingImage || busy) return;
    const file = pendingImage;
    const mime = imageMime(file);
    if (!mime) {
      setError('仅支持 PNG、JPEG、WebP 或 GIF 截图。');
      return;
    }
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const dataUrl = await readAsDataUrl(file);
      const data = dataUrl.split(',')[1] ?? '';
      const result = await api<ImportPreview>('vision_import_preview', {
        req: { data, mime, source: file.name, accountId }
      });
      setOrigin('AI 截图');
      applyPreview(result, 'review');
      setInfo('识别完成。模型可能看错或漏行，请逐行核对日期、数量、价格与合约后再提交。');
      clearPendingImage();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  async function readClipboardImage() {
    setError('');
    setInfo('');
    try {
      if (!navigator.clipboard?.read) throw new Error('unsupported');
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(value => value.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        const extension = type.split('/')[1] ?? 'png';
        stageImage(new File([blob], `clipboard.${extension}`, { type }));
        return;
      }
      setError('剪贴板中没有图片。');
    } catch {
      setError('无法读取剪贴板。请改用选择截图文件，或点击下方区域后按 Ctrl+V。');
    }
  }

  function handleImagePaste(event: ClipboardEvent<HTMLDivElement>) {
    const item = Array.from(event.clipboardData.items).find(entry => entry.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    stageImage(file);
  }

  function updateEvent(rowNumber: number, patch: Partial<CandidateEvent>) {
    setEdits(current => ({
      ...current,
      [rowNumber]: { ...current[rowNumber], ...patch },
    }));
  }

  function changeKind(row: CandidateRow, kind: string) {
    if (!row.event) return;
    const patch: Partial<CandidateEvent> = { kind };
    const option = OPTION_KINDS.has(kind);
    if (!option) {
      patch.expiry = null;
      patch.strike = null;
      patch.right = null;
      patch.multiplier = 100;
    }
    if (kind === 'fee' || kind === 'adjustment' || kind === 'interest') {
      patch.qty = 0;
      patch.price = 0;
    }
    if (CASH_KINDS.has(kind) || kind === 'interest') {
      patch.symbol = '';
      patch.qty = 0;
      patch.price = 0;
      patch.fees = 0;
    }
    if (kind === 'option_expire' || kind === 'option_assign') {
      patch.price = 0;
      patch.amount = 0;
    }
    updateEvent(row.rowNumber, patch);
  }

  function numberValue(raw: string, fallback = 0) {
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
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
          origin: mode === 'csv' ? (fileName || '粘贴文本') : (origin || 'AI 截图'),
          allowDuplicates,
          rows: selectedRows.map(row => ({ rowNumber: row.rowNumber, event: row.event! }))
        }
      });
      reset();
      const message = summary.batchSaved
        ? `已导入 ${summary.imported} 笔交易，账本已重算；可在“最近导入”整批撤销。`
        : `已导入 ${summary.imported} 笔交易，账本已重算；批次记录未保存，无法整批撤销。`;
      onCommitted(message);
      void loadBatches();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  async function loadBatches() {
    if (!desktop) return;
    setBatchBusy(true);
    setBatchError('');
    try {
      setBatches(await api<ImportBatch[]>('list_import_batches', { accountId }));
    } catch (failure) {
      setBatchError(String(failure));
    } finally {
      setBatchBusy(false);
    }
  }

  async function undoBatch() {
    if (!pendingBatch || batchBusy) return;
    setBatchBusy(true);
    setBatchError('');
    try {
      const result = await api<ImportBatch>('undo_import_batch', { batchId: pendingBatch.id });
      setBatches(current => current.map(item => (item.id === result.id ? result : item)));
      setPendingBatch(null);
      const message = `已整批撤销 ${result.undoneCount} 笔交易，账本已重算。`;
      setInfo(message);
      onCommitted(message);
    } catch (failure) {
      setBatchError(String(failure));
      setPendingBatch(null);
    } finally {
      setBatchBusy(false);
    }
  }

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setStep('source');
    setPreview(null);
    setMapping(null);
    setSelection({});
    setEdits({});
    clearPendingImage();
    setError('');
    setInfo('');
  }

  function reset() {
    setStep('source');
    setPaste('');
    setFileName('');
    setEncoding('');
    setEncodingWarning('');
    setOrigin('');
    setPreview(null);
    setMapping(null);
    setSelection({});
    setEdits({});
    clearPendingImage();
    setAllowDuplicates(false);
    setError('');
    setInfo('');
  }

  return (
    <div className="import-page grid gap-4">
      <div className="settings-tabs import-modes inline-flex w-fit gap-0.5 rounded-lg border bg-muted/40 p-0.5" aria-label="导入方式">
        {MODES.map(item => (
          <Button
            key={item.id}
            size="sm"
            variant={mode === item.id ? 'secondary' : 'ghost'}
            aria-pressed={mode === item.id}
            disabled={busy}
            onClick={() => switchMode(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <div className="wizard-steps flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-label="导入步骤">
        {(mode === 'csv' ? STEPS : VISION_STEPS).map((item, index) => (
          <span
            key={item.id}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1',
              step === item.id && 'active border-foreground/20 bg-accent text-foreground',
            )}
            aria-current={step === item.id ? 'step' : undefined}
          >
            {index + 1}. {item.label}
          </span>
        ))}
      </div>

      {!desktop && <Alert role="status" className="alert">浏览器仅预览界面。请启动桌面应用导入本地账本。</Alert>}
      {error && (
        <Alert variant="error" role="alert" className="alert error">
          <span>{error}</span>
          <div className="toolbar flex flex-wrap gap-2">
            <Button variant="outline" size="xs" onClick={() => setError('')}>关闭</Button>
            {mode === 'vision' && onOpenVisionSettings && /AI 识别|API Key|隐私说明/.test(error) && (
              <Button variant="outline" size="xs" onClick={onOpenVisionSettings}>前往设置 → AI 识别</Button>
            )}
          </div>
        </Alert>
      )}
      {info && <Alert variant="success" role="status" className="alert success">{info}</Alert>}

      {step === 'source' && (
        <Card>
          <CardPanel className="space-y-4">
            {mode === 'csv' && (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-heading text-base font-semibold">选择 CSV</h2>
                  <span className="text-xs text-muted-foreground">逗号 / 分号 / 制表符 · UTF-8 或 GB18030 · 最多 5000 行</span>
                </div>
                <label className="file-drop grid cursor-pointer place-items-center gap-1.5 rounded-xl border border-dashed bg-muted/30 px-4 py-8 text-center transition-colors hover:border-ring/60 hover:bg-muted/60">
                  <UploadIcon className="size-6 text-muted-foreground" />
                  <strong className="text-sm font-medium">{fileName || '选择 CSV 文件'}</strong>
                  <span className="text-xs text-muted-foreground">点击选择文件，或把 CSV 内容粘贴到下方</span>
                  <input
                    type="file"
                    className="sr-only"
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
                  <p className="import-meta text-xs text-muted-foreground">
                    {encoding && <>编码：{encoding}</>}
                    {encodingWarning && <> · {encodingWarning}</>}
                  </p>
                )}
                <label className="full import-paste grid gap-1.5 text-xs font-medium text-muted-foreground">
                  粘贴 CSV 文本
                  <Textarea
                    rows={10}
                    className="font-mono text-xs"
                    value={paste}
                    onChange={event => setPaste(event.target.value)}
                    placeholder={'日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌,乘数,备注\n2026-01-02,卖出开仓,AAPL,1,2.00,1.00,2026-02-20,150,P,100,'}
                  />
                </label>
                <div className="form-actions flex flex-wrap justify-end gap-2">
                  <Button variant="outline" onClick={reset} disabled={busy}>清空</Button>
                  <Button onClick={parsePasted} disabled={!desktop || busy || !paste.trim()}>
                    {busy ? '解析中…' : '解析预览'}
                  </Button>
                </div>
              </>
            )}

            {mode === 'vision' && (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-heading text-base font-semibold">AI 截图识别</h2>
                  <span className="text-xs text-muted-foreground">OpenAI 兼容视觉模型 · PNG / JPEG / WebP / GIF · 最多 5 MB</span>
                </div>
                <label className="file-drop grid cursor-pointer place-items-center gap-1.5 rounded-xl border border-dashed bg-muted/30 px-4 py-8 text-center transition-colors hover:border-ring/60 hover:bg-muted/60">
                  <UploadIcon className="size-6 text-muted-foreground" />
                  <strong className="text-sm font-medium">{imageName || '选择截图文件'}</strong>
                  <span className="text-xs text-muted-foreground">点击选择截图，或在下方区域按 Ctrl+V 粘贴</span>
                  <input
                    type="file"
                    className="sr-only"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    disabled={!desktop || busy}
                    onChange={event => {
                      const file = event.target.files?.[0];
                      stageImage(file);
                      event.target.value = '';
                    }}
                  />
                </label>
                <div
                  className="vision-paste grid cursor-text place-items-center gap-1.5 rounded-xl border border-dashed bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
                  tabIndex={0}
                  role="button"
                  aria-label="粘贴截图"
                  onPaste={handleImagePaste}
                >
                  <ClipboardIcon className="size-5" />
                  <span>在此区域按 Ctrl+V 粘贴截图</span>
                </div>
                <Alert variant="warning" role="status" className="alert warning vision-privacy">
                  <div className="space-y-1.5">
                    <strong className="block text-sm font-medium">截图会发送到你配置的云端视觉服务</strong>
                    <p className="text-xs leading-relaxed">图片可能包含账户、持仓与交易信息。请只使用你信任的服务，并确认已在设置 → AI 识别中启用。</p>
                    <p className="text-xs leading-relaxed">模型可能看错、漏行或把相似字符混淆。识别结果只是草稿，必须逐行核对后才能提交。</p>
                  </div>
                </Alert>
                {pendingImage && (
                  <Alert variant="warning" role="status" className="alert warning vision-confirm">
                    <div className="space-y-2">
                      <strong className="block text-sm font-medium">确认上传 “{imageName}”？</strong>
                      <img src={pendingImageUrl} alt="待上传截图预览" className="vision-thumb max-h-48 rounded-lg border" />
                      <p className="text-xs leading-relaxed">目标服务：设置 → AI 识别中配置的 OpenAI 兼容视觉服务。文件大小约 {Math.max(1, Math.ceil(pendingImage.size / 1024))} KB。</p>
                      <div className="toolbar flex flex-wrap gap-2">
                        <Button variant="outline" size="sm" onClick={clearPendingImage} disabled={busy}>取消上传</Button>
                        <Button size="sm" onClick={() => void uploadPendingImage()} disabled={busy}>
                          {busy ? '正在识别…' : '确认上传并识别'}
                        </Button>
                      </div>
                    </div>
                  </Alert>
                )}
                <div className="form-actions flex flex-wrap justify-end gap-2">
                  <Button variant="outline" onClick={reset} disabled={busy}>清空</Button>
                  <Button variant="outline" onClick={() => void readClipboardImage()} disabled={!desktop || busy}>从剪贴板读取</Button>
                  {onOpenVisionSettings && (
                    <Button variant="outline" onClick={onOpenVisionSettings} disabled={busy}>AI 识别设置</Button>
                  )}
                </div>
                <p className="import-meta text-xs leading-relaxed text-muted-foreground">
                  选择截图后先显示预览；只有点击“确认上传并识别”才会发送，识别结果不会自动入账。
                </p>
              </>
            )}
          </CardPanel>
        </Card>
      )}

      {step === 'source' && (
        <Card className="import-batches">
          <CardHeader>
            <CardTitle className="text-base">最近导入</CardTitle>
            <CardDescription>整批撤销会重算账本；原始记录仍保留在数据库中</CardDescription>
          </CardHeader>
          <CardPanel className="space-y-3">
            <div className="flex justify-end">
              <Button variant="outline" size="xs" onClick={() => void loadBatches()} disabled={batchBusy}>
                <RefreshCwIcon />{batchBusy ? '读取中…' : '刷新'}
              </Button>
            </div>
            {batchError && <p className="negative text-xs text-destructive-foreground" role="alert">{batchError}</p>}
            {!batches.length ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>还没有导入批次</EmptyTitle>
                  <EmptyDescription>导入成功后，会在这里显示可整批撤销的批次。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="overflow-hidden rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>批次</TableHead>
                      <TableHead>来源</TableHead>
                      <TableHead>时间（UTC）</TableHead>
                      <TableHead className="text-right">导入</TableHead>
                      <TableHead className="text-right">剩余</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {batches.map(batch => {
                      const status = batch.undoneAt ? '已整批撤销' : batch.remaining === 0 ? '已全部逐笔撤销' : '可撤销';
                      return (
                        <TableRow key={batch.id}>
                          <TableCell><code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{batch.id}</code></TableCell>
                          <TableCell>{batch.origin}</TableCell>
                          <TableCell className="num text-xs">{batch.createdAt.replace(' +00:00', ' UTC')}</TableCell>
                          <TableCell className="num text-right">{batch.imported}</TableCell>
                          <TableCell className="num text-right">{batch.remaining}</TableCell>
                          <TableCell>
                            <Badge variant={batch.undoneAt ? 'outline' : batch.remaining === 0 ? 'secondary' : 'success'} size="sm">{status}</Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end">
                              <Button
                                variant="destructive-outline"
                                size="xs"
                                disabled={batchBusy || Boolean(batch.undoneAt) || batch.remaining === 0}
                                onClick={() => setPendingBatch(batch)}
                              >
                                整批撤销
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardPanel>
        </Card>
      )}

      {pendingBatch && (
        <div className="modal-backdrop fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm">
          <section role="dialog" aria-modal="true" aria-labelledby="batch-undo-title" className="modal w-full max-w-md space-y-3 rounded-2xl border bg-card p-5 shadow-xl">
            <h2 id="batch-undo-title" className="font-heading text-base font-semibold">确认整批撤销？</h2>
            <p className="text-sm text-muted-foreground">将撤销批次 <strong className="text-foreground">{pendingBatch.id.slice(-12)}</strong> 中仍有效的 {pendingBatch.remaining} 笔交易，并重算持仓与成本。如果后续交易依赖其中记录，系统会拒绝并保持原账本不变。原始记录仍保留在数据库中。</p>
            <div className="toolbar flex justify-end gap-2">
              <Button variant="outline" size="sm" autoFocus disabled={batchBusy} onClick={() => setPendingBatch(null)}>取消</Button>
              <Button variant="destructive" size="sm" disabled={batchBusy} onClick={() => void undoBatch()}>
                {batchBusy ? '正在撤销…' : '确认整批撤销'}
              </Button>
            </div>
          </section>
        </div>
      )}

      {step === 'map' && preview && mapping && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">确认列映射</CardTitle>
            <CardDescription>{MAPPING_SOURCE[preview.mappingSource]} · 签名 {preview.signature}</CardDescription>
          </CardHeader>
          <CardPanel className="space-y-4">
            {preview.warnings.length > 0 && (
              <Alert variant="warning" role="status" className="alert warning">
                {preview.warnings.map(warning => <div key={warning}>{warning}</div>)}
              </Alert>
            )}
            <div className="mapping-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {FIELDS.map(field => (
                <Field key={field.id} label={field.label}>
                  <NativeSelect
                    value={mapping.fields[field.id] ?? ''}
                    onChange={event => updateField(field.id, event.target.value)}
                  >
                    <option value="">不导入</option>
                    {preview.headers.map((header, index) => (
                      <option key={`${field.id}-${index}`} value={index}>{header || `列 ${index + 1}`}</option>
                    ))}
                  </NativeSelect>
                </Field>
              ))}
              <Field label="日期格式">
                <NativeSelect
                  value={mapping.dateFormat}
                  onChange={event => updateMapping({ dateFormat: event.target.value as ImportDateFormat })}
                >
                  <option value="auto">自动识别</option>
                  <option value="yearMonthDay">年-月-日</option>
                  <option value="monthDayYear">月/日/年</option>
                  <option value="chinese">中文日期</option>
                </NativeSelect>
              </Field>
              <Field label="分隔符">
                <NativeSelect
                  value={mapping.delimiter ?? ''}
                  onChange={event => updateMapping({ delimiter: event.target.value === '' ? null : (event.target.value as ImportDelimiter) })}
                >
                  <option value="">自动识别</option>
                  <option value="comma">逗号</option>
                  <option value="semicolon">分号</option>
                  <option value="tab">制表符</option>
                </NativeSelect>
              </Field>
              <Field label="首行是表头">
                <NativeSelect
                  value={mapping.hasHeader === null ? '' : String(mapping.hasHeader)}
                  onChange={event => updateMapping({ hasHeader: event.target.value === '' ? null : event.target.value === 'true' })}
                >
                  <option value="">自动判断</option>
                  <option value="true">是</option>
                  <option value="false">否</option>
                </NativeSelect>
              </Field>
            </div>
            <div className="form-actions flex flex-wrap items-center justify-between gap-2 border-t pt-4">
              <Button variant="ghost" onClick={() => setStep('source')} disabled={busy}><ArrowLeftIcon />返回</Button>
              <div className="toolbar flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => void saveMapping()} disabled={busy}>保存此映射</Button>
                <Button variant="outline" onClick={() => void runPreview(paste, mapping)} disabled={busy}>重新预览</Button>
                <Button onClick={() => setStep('review')} disabled={busy || !rows.length}>
                  下一步 · 逐行确认
                </Button>
              </div>
            </div>
          </CardPanel>
        </Card>
      )}

      {step === 'review' && preview && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">逐行确认</CardTitle>
            <CardDescription>
              共 {preview.counts.total} 行 · 可导入 {preview.counts.ok + preview.counts.warning} · 重复 {preview.counts.duplicate} · 错误 {preview.counts.error}
            </CardDescription>
          </CardHeader>
          <CardPanel className="space-y-3">
            {preview.warnings.length > 0 && (
              <Alert variant="warning" role="status" className="alert warning">
                {preview.warnings.map(warning => <div key={warning}>{warning}</div>)}
              </Alert>
            )}
            <Alert variant="warning" role="status" className="alert warning">
              提交时会按账本顺序整体校验；任一行不合法，整批都不会入账。
            </Alert>
            <p className="text-xs leading-relaxed text-muted-foreground">拆股 / 合股不会从 CSV 或截图自动识别，请使用「记一笔 → 拆股 / 合股」手工录入比例与零股补偿；导入只读取券商明确给出的「乘数」列。</p>
            <div className="toolbar import-toolbar flex flex-wrap gap-2">
              <Button variant="outline" size="xs" onClick={() => selectAll(true)} disabled={busy}>全选可导入</Button>
              <Button variant="outline" size="xs" onClick={() => selectAll(false)} disabled={busy}>清空选择</Button>
              <Button variant="ghost" size="xs" onClick={() => setStep(mode === 'csv' ? 'map' : 'source')} disabled={busy}>
                <ArrowLeftIcon />{mode === 'csv' ? '返回映射' : '返回来源'}
              </Button>
            </div>
            <div className="overflow-x-auto rounded-xl border">
              <Table className="import-table min-w-[1080px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>选择</TableHead><TableHead>行</TableHead><TableHead>状态</TableHead><TableHead>类型</TableHead><TableHead>日期</TableHead>
                    <TableHead>标的 / 合约</TableHead><TableHead>数量</TableHead><TableHead>价格</TableHead><TableHead>费用</TableHead><TableHead>金额</TableHead><TableHead>说明</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(row => (
                    <TableRow key={row.rowNumber} className={row.status === 'error' ? 'row-error bg-destructive/6' : undefined}>
                      <TableCell>
                        <input
                          type="checkbox"
                          className="size-3.5 rounded border-input accent-primary"
                          aria-label={`选择第 ${row.rowNumber} 行`}
                          checked={Boolean(selection[row.rowNumber])}
                          disabled={!row.event}
                          onChange={event => setSelection(current => ({ ...current, [row.rowNumber]: event.target.checked }))}
                        />
                      </TableCell>
                      <TableCell className="num text-xs">{row.rowNumber}</TableCell>
                      <TableCell><Badge variant={STATUS_TONE[row.status]} size="sm">{STATUS[row.status]}</Badge></TableCell>
                      <TableCell>
                        <NativeSelect
                          className="h-7 min-w-36 text-xs"
                          aria-label={`第 ${row.rowNumber} 行类型`}
                          value={row.event?.kind ?? ''}
                          disabled={!row.event || busy}
                          onChange={event => changeKind(row, event.target.value)}
                        >
                          {!row.event && <option value="">—</option>}
                          {KINDS.map(kind => <option key={kind} value={kind}>{labels[kind]}</option>)}
                        </NativeSelect>
                      </TableCell>
                      <TableCell>
                        {row.event ? (
                          <Input
                            type="date"
                            className="h-7 w-34 text-xs"
                            aria-label={`第 ${row.rowNumber} 行日期`}
                            value={row.event.date}
                            disabled={busy}
                            onChange={event => updateEvent(row.rowNumber, { date: event.target.value })}
                          />
                        ) : '—'}
                      </TableCell>
                      <TableCell>
                        {row.event ? (
                          <div className="import-contract flex flex-wrap items-center gap-1">
                            <Input
                              type="text"
                              className="h-7 w-20 text-xs"
                              aria-label={`第 ${row.rowNumber} 行标的`}
                              value={CASH_KINDS.has(row.event.kind) ? '' : row.event.symbol}
                              placeholder={CASH_KINDS.has(row.event.kind) ? '账户级' : undefined}
                              disabled={busy || CASH_KINDS.has(row.event.kind)}
                              onChange={event => updateEvent(row.rowNumber, { symbol: event.target.value })}
                            />
                            {OPTION_KINDS.has(row.event.kind) && <>
                              <Input
                                type="date"
                                className="h-7 w-32 text-xs"
                                aria-label={`第 ${row.rowNumber} 行到期日`}
                                value={row.event.expiry ?? ''}
                                disabled={busy}
                                onChange={event => updateEvent(row.rowNumber, { expiry: event.target.value || null })}
                              />
                              <Input
                                type="number"
                                min="0"
                                step="any"
                                className="h-7 w-20 text-xs"
                                aria-label={`第 ${row.rowNumber} 行行权价`}
                                value={row.event.strike ?? ''}
                                disabled={busy}
                                onChange={event => updateEvent(row.rowNumber, { strike: event.target.value === '' ? null : numberValue(event.target.value) })}
                              />
                              <NativeSelect
                                className="h-7 w-16 text-xs"
                                aria-label={`第 ${row.rowNumber} 行看涨看跌`}
                                value={row.event.right ?? ''}
                                disabled={busy}
                                onChange={event => updateEvent(row.rowNumber, { right: event.target.value || null })}
                              >
                                <option value="">—</option>
                                <option value="P">Put</option>
                                <option value="C">Call</option>
                              </NativeSelect>
                              <Input
                                type="number"
                                min="1"
                                step="1"
                                className="h-7 w-18 text-xs"
                                aria-label={`第 ${row.rowNumber} 行乘数`}
                                value={row.event.multiplier}
                                disabled={busy}
                                onChange={event => updateEvent(row.rowNumber, { multiplier: Math.max(1, Math.trunc(numberValue(event.target.value, 1))) })}
                              />
                            </>}
                          </div>
                        ) : '—'}
                      </TableCell>
                      <TableCell>
                        {row.event ? (
                          <Input
                            type="number"
                            min="0"
                            step="1"
                            className="h-7 w-16 text-xs"
                            aria-label={`第 ${row.rowNumber} 行数量`}
                            value={row.event.qty}
                            disabled={busy}
                            onChange={event => updateEvent(row.rowNumber, { qty: Math.max(0, Math.trunc(numberValue(event.target.value))) })}
                          />
                        ) : '—'}
                      </TableCell>
                      <TableCell>
                        {row.event ? (
                          <Input
                            type="number"
                            min="0"
                            step="any"
                            className="h-7 w-20 text-xs"
                            aria-label={`第 ${row.rowNumber} 行价格`}
                            value={row.event.price}
                            disabled={busy}
                            onChange={event => updateEvent(row.rowNumber, { price: numberValue(event.target.value) })}
                          />
                        ) : '—'}
                      </TableCell>
                      <TableCell>
                        {row.event ? (
                          <Input
                            type="number"
                            min="0"
                            step="any"
                            className="h-7 w-18 text-xs"
                            aria-label={`第 ${row.rowNumber} 行费用`}
                            value={row.event.fees}
                            disabled={busy}
                            onChange={event => updateEvent(row.rowNumber, { fees: numberValue(event.target.value) })}
                          />
                        ) : '—'}
                      </TableCell>
                      <TableCell>
                        {row.event ? (
                          <Input
                            type="number"
                            step="any"
                            className="h-7 w-20 text-xs"
                            aria-label={`第 ${row.rowNumber} 行金额`}
                            value={row.event.amount}
                            disabled={busy}
                            onChange={event => updateEvent(row.rowNumber, { amount: numberValue(event.target.value) })}
                          />
                        ) : '—'}
                      </TableCell>
                      <TableCell className="import-message max-w-64 text-xs text-muted-foreground">{row.messages.length ? row.messages.join(' ') : row.raw}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {duplicateSelected > 0 && (
              <label className="check import-duplicates flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-3.5 rounded border-input accent-primary"
                  checked={allowDuplicates}
                  onChange={event => setAllowDuplicates(event.target.checked)}
                />
                允许重复导入 {duplicateSelected} 行
              </label>
            )}
            <div className="form-actions flex flex-wrap items-center justify-between gap-2 border-t pt-4">
              <span className="text-xs text-muted-foreground">已选择 {selectedRows.length} 行{duplicateSelected > 0 ? `，其中重复 ${duplicateSelected} 行` : ''}</span>
              <Button onClick={() => void commit()} disabled={!canCommit}>
                <CheckIcon />{busy ? '导入中…' : `确认导入 ${selectedRows.length} 笔`}
              </Button>
            </div>
          </CardPanel>
        </Card>
      )}
    </div>
  );
}
