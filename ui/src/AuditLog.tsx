import { useCallback, useEffect, useState } from 'react';
import { HistoryIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NativeSelect } from '@/components/native-select';
import { api, desktop, labels, money } from './lib';
import type { AuditAction, AuditEntry, AuditLog, AuditSnapshot } from './types';

const ACTION_LABEL: Record<AuditAction, string> = { insert: '新增', update: '修改', delete: '撤销' };
const ACTION_VARIANT: Record<AuditAction, 'success' | 'warning' | 'secondary'> = {
  insert: 'success', update: 'warning', delete: 'secondary',
};
const CASH_KINDS = new Set(['cash_deposit', 'cash_withdrawal', 'fee', 'interest', 'adjustment']);

function snapshotOf(entry: AuditEntry): AuditSnapshot | null {
  return entry.after ?? entry.before;
}

function contractLabel(snapshot: AuditSnapshot) {
  if (CASH_KINDS.has(snapshot.kind)) return '账户级';
  const contract = snapshot.expiry
    ? `${snapshot.expiry} ${snapshot.strike ?? ''}${snapshot.right ?? ''}`
    : '';
  return contract ? `${snapshot.symbol} ${contract}` : snapshot.symbol;
}

function amountLabel(snapshot: AuditSnapshot) {
  if (snapshot.kind === 'option_open_short' || snapshot.kind === 'option_close') {
    return `${money(snapshot.price)} × ${snapshot.qty}`;
  }
  if (snapshot.kind === 'dividend') return `${money(snapshot.price)} × ${snapshot.qty} 股`;
  if (CASH_KINDS.has(snapshot.kind)) return money(snapshot.amount);
  return `${money(snapshot.price)} × ${snapshot.qty} 股`;
}

function number(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function changedFields(before: AuditSnapshot, after: AuditSnapshot) {
  const changes: string[] = [];
  const add = (label: string, left: string | number | null, right: string | number | null) => {
    if (left !== right) changes.push(`${label} ${left ?? '—'} → ${right ?? '—'}`);
  };
  add('日期', before.date, after.date);
  add('类型', labels[before.kind] ?? before.kind, labels[after.kind] ?? after.kind);
  add('标的', before.symbol, after.symbol);
  add('到期', before.expiry, after.expiry);
  add('行权价', before.strike, after.strike);
  add('方向', before.right, after.right);
  add('乘数', before.multiplier, after.multiplier);
  add('数量', before.qty, after.qty);
  add('价格', number(before.price), number(after.price));
  add('费用', number(before.fees), number(after.fees));
  add('金额', number(before.amount), number(after.amount));
  add('备注', before.note || '—', after.note || '—');
  return changes;
}

function changeSummary(entry: AuditEntry) {
  if (entry.action === 'insert') {
    const snapshot = entry.after;
    return snapshot ? `新增${snapshot.note ? ` · ${snapshot.note}` : ''}` : '新增';
  }
  if (entry.action === 'delete') {
    const snapshot = entry.before;
    return snapshot ? `撤销前${snapshot.note ? ` · ${snapshot.note}` : ''}` : '撤销';
  }
  if (entry.before && entry.after) {
    const changes = changedFields(entry.before, entry.after);
    return changes.length ? changes.join('；') : '无字段变化';
  }
  return '—';
}

export function AuditLogPage({ accountId }: { accountId: string }) {
  const [scope, setScope] = useState<'account' | 'all'>('account');
  const [action, setAction] = useState('');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!desktop) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<AuditLog>('audit_log', {
        accountId: scope === 'account' ? accountId : undefined,
        action: action || undefined,
        limit: 200,
      });
      setEntries(result.entries);
    } catch (failure) {
      setEntries([]);
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }, [accountId, scope, action]);

  useEffect(() => { void load(); }, [load]);

  return (
    <Card className="audit-log">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><HistoryIcon className="size-4 text-muted-foreground" />审计日志</CardTitle>
        <CardDescription>新增、修改与撤销的完整轨迹 · 保留最近 200 条</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-4">
        <div className="flex flex-wrap items-end justify-end gap-2">
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            范围
            <NativeSelect aria-label="审计范围" className="w-36" value={scope} onChange={event => setScope(event.target.value as 'account' | 'all')}>
              <option value="account">当前账户</option>
              <option value="all">全部账户</option>
            </NativeSelect>
          </label>
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            动作
            <NativeSelect aria-label="审计动作筛选" className="w-32" value={action} onChange={event => setAction(event.target.value)}>
              <option value="">全部动作</option>
              <option value="insert">新增</option>
              <option value="update">修改</option>
              <option value="delete">撤销</option>
            </NativeSelect>
          </label>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy || !desktop}>
            {busy ? '读取中…' : '刷新'}
          </Button>
        </div>

        {!desktop && <p className="text-sm text-muted-foreground">浏览器预览不读取本地账本，请在桌面应用查看审计日志。</p>}
        {error && (
          <Alert variant="error">
            <AlertDescription>审计日志读取失败：{error}</AlertDescription>
          </Alert>
        )}

        {entries.length ? (
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>记录时间</TableHead>
                  <TableHead>动作</TableHead>
                  <TableHead>交易日期</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>标的 / 合约</TableHead>
                  <TableHead>数量 / 金额</TableHead>
                  <TableHead>变更</TableHead>
                  <TableHead>账户</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map(entry => {
                  const snapshot = snapshotOf(entry);
                  return (
                    <TableRow key={entry.id}>
                      <TableCell className="num whitespace-nowrap">{entry.recordedAt.slice(0, 19).replace('T', ' ')}</TableCell>
                      <TableCell><Badge variant={ACTION_VARIANT[entry.action]} size="sm">{ACTION_LABEL[entry.action]}</Badge></TableCell>
                      <TableCell className="num">{snapshot?.date ?? '—'}</TableCell>
                      <TableCell>{snapshot ? labels[snapshot.kind] ?? snapshot.kind : '—'}</TableCell>
                      <TableCell>{snapshot ? contractLabel(snapshot) : '—'}</TableCell>
                      <TableCell className="num">{snapshot ? amountLabel(snapshot) : '—'}</TableCell>
                      <TableCell className="note-cell max-w-[340px] whitespace-normal">{changeSummary(entry)}</TableCell>
                      <TableCell>{entry.accountName}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : !busy && !error && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>暂无审计记录</EmptyTitle>
              <EmptyDescription>新增、修改或撤销交易后，这里会保留每次写入的前后快照。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        <p className="footnote text-xs leading-relaxed text-muted-foreground">
          审计日志是只读的追加记录：修改会同时保留修改前与修改后字段，撤销会保留撤销前快照。记录随数据库备份一起保存；导出 JSON 与交易 CSV 不包含审计日志。
        </p>
      </CardPanel>
    </Card>
  );
}
