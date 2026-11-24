import { useEffect, useState } from 'react';
import { NotebookPenIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import type { CampaignNote } from './types';

const LIMIT = 4000;

export function CampaignNotes({ note, onSave }: {
  note?: CampaignNote;
  onSave: (note: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(note?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(note?.note ?? '');
    setError('');
  }, [note?.campaignId, note?.note]);

  const current = note?.note ?? '';
  const dirty = draft.trim() !== current;

  async function save() {
    if (busy || !dirty) return;
    setBusy(true);
    setError('');
    try {
      await onSave(draft);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="campaign-notes">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><NotebookPenIcon className="size-4 text-muted-foreground" />战役笔记</CardTitle>
        <CardDescription>记录为什么开这一轮：投资理由、计划、风险与退出条件。笔记只保存在本机账本，不参与收益计算。</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-2">
        {error && (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Textarea
          aria-label="战役笔记"
          rows={4}
          maxLength={LIMIT}
          value={draft}
          disabled={busy}
          placeholder="例如：财报后 IV 偏高，计划在 140 附近卖 30 天 Put；跌破 130 重新评估，若被指派则转到备兑 Call。"
          onChange={event => setDraft(event.target.value)}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {note?.updatedAt ? `更新于 ${note.updatedAt.slice(0, 19).replace('T', ' ')}` : '尚未记录笔记'} · {draft.trim().length}/{LIMIT}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={!dirty || busy} onClick={() => setDraft(current)}>撤销更改</Button>
            <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存笔记'}</Button>
          </div>
        </div>
      </CardPanel>
    </Card>
  );
}
