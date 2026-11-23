import { useState, type FormEvent } from 'react';
import { ArchiveIcon, ArchiveRestoreIcon, CheckIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from './lib';
import type { Account } from './types';

interface Props {
  accounts: Account[];
  currentId: string;
  onSwitch: (id: string) => void;
  onAccounts: (accounts: Account[]) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

export function AccountsPanel({ accounts, currentId, onSwitch, onAccounts, onNotice, onError }: Props) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Account | null>(null);

  const active = accounts.filter(account => !account.archivedAt);
  const archived = accounts.filter(account => account.archivedAt);
  const activeCount = active.length;

  async function refresh(): Promise<Account[]> {
    const list = await api<Account[]>('list_accounts');
    onAccounts(list);
    return list;
  }

  function switchAwayFrom(accountId: string, list: Account[]) {
    if (accountId !== currentId) return;
    const fallback = list.find(account => !account.archivedAt && account.id !== accountId);
    if (fallback) onSwitch(fallback.id);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); onError('');
    try {
      const created = await api<Account>('create_account', { name });
      setName('');
      await refresh();
      onSwitch(created.id);
      onNotice(`已创建账户「${created.name}」并切换过去。`);
    } catch (failure) { onError(String(failure)); } finally { setBusy(false); }
  }

  function beginRename(account: Account) {
    setRenaming(account.id);
    setRenameValue(account.name);
    onError('');
  }

  async function saveRename(account: Account) {
    if (busy) return;
    setBusy(true); onError('');
    try {
      const updated = await api<Account>('rename_account', { accountId: account.id, name: renameValue });
      setRenaming(null);
      await refresh();
      onNotice(`账户已重命名为「${updated.name}」。`);
    } catch (failure) { onError(String(failure)); } finally { setBusy(false); }
  }

  async function setArchived(account: Account, archivedFlag: boolean) {
    if (busy) return;
    setBusy(true); onError('');
    try {
      await api<Account>('set_account_archived', { accountId: account.id, archived: archivedFlag });
      const list = await refresh();
      switchAwayFrom(account.id, list);
      onNotice(archivedFlag ? `已归档账户「${account.name}」，数据仍然保留。` : `已恢复账户「${account.name}」。`);
    } catch (failure) { onError(String(failure)); } finally { setBusy(false); }
  }

  async function confirmDelete() {
    if (!pendingDelete || busy) return;
    setBusy(true); onError('');
    try {
      await api<boolean>('delete_account', { accountId: pendingDelete.id });
      const name = pendingDelete.name;
      setPendingDelete(null);
      const list = await refresh();
      switchAwayFrom(pendingDelete.id, list);
      onNotice(`已删除空账户「${name}」。`);
    } catch (failure) { onError(String(failure)); } finally { setBusy(false); }
  }

  function deleteBlocked(account: Account): string | null {
    if (account.eventCount > 0) return '账户下还有交易（含已撤销），只能归档';
    if (!account.archivedAt && activeCount <= 1) return '至少保留一个可用账户';
    return null;
  }

  function renderActions(account: Account, isArchived: boolean) {
    const blocked = deleteBlocked(account);
    return (
      <div className="flex flex-wrap justify-end gap-1">
        {renaming === account.id ? (
          <>
            <Button variant="outline" size="xs" aria-label="保存名称" disabled={busy || !renameValue.trim()} onClick={() => void saveRename(account)}><CheckIcon />保存</Button>
            <Button variant="ghost" size="xs" aria-label="取消重命名" onClick={() => setRenaming(null)}><XIcon />取消</Button>
          </>
        ) : (
          <>
            {!isArchived && <Button variant="outline" size="xs" disabled={busy || account.id === currentId} onClick={() => onSwitch(account.id)}>{account.id === currentId ? '使用中' : '切换'}</Button>}
            {!isArchived && <Button variant="ghost" size="xs" aria-label={`重命名 ${account.name}`} disabled={busy} onClick={() => beginRename(account)}><PencilIcon />重命名</Button>}
            {isArchived
              ? <Button variant="outline" size="xs" aria-label={`恢复 ${account.name}`} disabled={busy} onClick={() => void setArchived(account, false)}><ArchiveRestoreIcon />恢复</Button>
              : <Button variant="ghost" size="xs" aria-label={`归档 ${account.name}`} title={activeCount <= 1 ? '至少保留一个可用账户' : undefined} disabled={busy || activeCount <= 1} onClick={() => void setArchived(account, true)}><ArchiveIcon />归档</Button>}
            <Button variant="ghost" size="xs" aria-label={`删除 ${account.name}`} title={blocked ?? undefined} disabled={busy || blocked !== null} onClick={() => { onError(''); setPendingDelete(account); }}><Trash2Icon />删除</Button>
          </>
        )}
      </div>
    );
  }

  return (
    <Card className="account-panel">
      <CardHeader>
        <CardTitle className="text-base">可用账户</CardTitle>
        <CardDescription>每个账户有独立账本、持仓与成本</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-4">
        <p className="text-xs leading-relaxed text-muted-foreground">切换账户只会改变当前查看的账本，不会合并数据。行情报价与成本口径为全局设置。归档会从切换器隐藏账户但保留全部数据；只有没有任何交易的空账户可以删除。</p>
        {active.length ? (
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>币种</TableHead>
                  <TableHead className="text-right">交易</TableHead>
                  <TableHead>建立日期</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {active.map(account => (
                  <TableRow key={account.id}>
                    <TableCell>
                      {renaming === account.id ? (
                        <Input aria-label={`重命名 ${account.name}`} className="h-7 max-w-48" autoFocus maxLength={40} value={renameValue} onChange={event => setRenameValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void saveRename(account); if (event.key === 'Escape') setRenaming(null); }} />
                      ) : (
                        <span className="flex items-center gap-2">
                          {account.name}
                          {account.id === currentId && <Badge variant="success" size="sm">当前</Badge>}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{account.currency}</TableCell>
                    <TableCell className="num text-right">{account.eventCount}</TableCell>
                    <TableCell className="num">{account.createdAt}</TableCell>
                    <TableCell>{renderActions(account, false)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>还没有可用账户</EmptyTitle>
              <EmptyDescription>在下方创建第一个账户，即可开始记账。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {archived.length > 0 && (
          <div className="space-y-2">
            <h3 className="account-section-title font-heading text-sm font-semibold">已归档</h3>
            <p className="text-xs text-muted-foreground">归档账户的数据仍然保留，恢复后会重新出现在切换器中。</p>
            <div className="overflow-hidden rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>归档日期</TableHead>
                    <TableHead className="text-right">交易</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {archived.map(account => (
                    <TableRow key={account.id}>
                      <TableCell>{account.name}</TableCell>
                      <TableCell className="num">{account.archivedAt}</TableCell>
                      <TableCell className="num text-right">{account.eventCount}</TableCell>
                      <TableCell>{renderActions(account, true)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <form className="account-create flex flex-wrap items-end gap-3 border-t pt-4" onSubmit={create}>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            新账户名称
            <Input required maxLength={40} className="min-w-56" placeholder="例如：长期账户" value={name} onChange={event => setName(event.target.value)} />
          </label>
          <Button type="submit" disabled={busy || !name.trim()}><PlusIcon />创建并切换</Button>
        </form>
        <p className="footnote text-xs leading-relaxed text-muted-foreground">账户名称不可重复；单个账本最多 50 个账户（含已归档）。</p>

        {pendingDelete && (
          <div className="modal-backdrop fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm">
            <section role="dialog" aria-modal="true" aria-labelledby="delete-account-title" className="modal w-full max-w-md space-y-3 rounded-2xl border bg-card p-5 shadow-xl">
              <h2 id="delete-account-title" className="font-heading text-base font-semibold">确认删除空账户「{pendingDelete.name}」？</h2>
              <p className="text-sm text-muted-foreground">删除后账户从列表中移除。只有没有任何交易记录（含已撤销）的账户可以删除；此操作不可撤销。</p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" autoFocus disabled={busy} onClick={() => setPendingDelete(null)}>取消</Button>
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => void confirmDelete()}>{busy ? '正在删除…' : '确认删除'}</Button>
              </div>
            </section>
          </div>
        )}
      </CardPanel>
    </Card>
  );
}
