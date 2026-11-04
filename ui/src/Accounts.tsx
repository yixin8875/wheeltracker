import { useState, type FormEvent } from 'react';
import { Archive, ArchiveRestore, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
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
    return <div className="toolbar">
      {renaming === account.id
        ? <><button aria-label="保存名称" disabled={busy || !renameValue.trim()} onClick={() => void saveRename(account)}><Check size={15}/>保存</button><button aria-label="取消重命名" onClick={() => setRenaming(null)}><X size={15}/>取消</button></>
        : <>
          {!isArchived && <button disabled={busy || account.id === currentId} onClick={() => onSwitch(account.id)}>{account.id === currentId ? '使用中' : '切换'}</button>}
          {!isArchived && <button aria-label={`重命名 ${account.name}`} disabled={busy} onClick={() => beginRename(account)}><Pencil size={15}/>重命名</button>}
          {isArchived
            ? <button aria-label={`恢复 ${account.name}`} disabled={busy} onClick={() => void setArchived(account, false)}><ArchiveRestore size={15}/>恢复</button>
            : <button aria-label={`归档 ${account.name}`} title={activeCount <= 1 ? '至少保留一个可用账户' : undefined} disabled={busy || activeCount <= 1} onClick={() => void setArchived(account, true)}><Archive size={15}/>归档</button>}
          <button aria-label={`删除 ${account.name}`} title={blocked ?? undefined} disabled={busy || blocked !== null} onClick={() => { onError(''); setPendingDelete(account); }}><Trash2 size={15}/>删除</button>
        </>}
    </div>;
  }

  return <section className="panel account-panel">
    <div className="section-heading"><h2>账户</h2><span className="muted">每个账户有独立账本、持仓与成本</span></div>
    <p className="muted">切换账户只会改变当前查看的账本，不会合并数据。行情报价与成本口径为全局设置。归档会从切换器隐藏账户但保留全部数据；只有没有任何交易的空账户可以删除。</p>
    <div className="table-wrap"><table><thead><tr><th>名称</th><th>币种</th><th>交易</th><th>建立日期</th><th>操作</th></tr></thead><tbody>
      {active.map(account => <tr key={account.id}>
        <td>{renaming === account.id
          ? <input aria-label={`重命名 ${account.name}`} autoFocus maxLength={40} value={renameValue} onChange={event => setRenameValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void saveRename(account); if (event.key === 'Escape') setRenaming(null); }}/>
          : <>{account.name}{account.id === currentId && <span className="badge active">当前</span>}</>}</td>
        <td>{account.currency}</td>
        <td>{account.eventCount}</td>
        <td>{account.createdAt}</td>
        <td>{renderActions(account, false)}</td>
      </tr>)}
    </tbody></table></div>
    {!active.length && <p className="empty">还没有可用账户。</p>}
    {archived.length > 0 && <>
      <h3 className="account-section-title">已归档</h3>
      <p className="muted">归档账户的数据仍然保留，恢复后会重新出现在切换器中。</p>
      <div className="table-wrap"><table><thead><tr><th>名称</th><th>归档日期</th><th>交易</th><th>操作</th></tr></thead><tbody>
        {archived.map(account => <tr key={account.id}>
          <td>{account.name}</td>
          <td>{account.archivedAt}</td>
          <td>{account.eventCount}</td>
          <td>{renderActions(account, true)}</td>
        </tr>)}
      </tbody></table></div>
    </>}
    <form className="account-create" onSubmit={create}>
      <label>新账户名称<input required maxLength={40} placeholder="例如：长期账户" value={name} onChange={event => setName(event.target.value)}/></label>
      <button type="submit" className="primary" disabled={busy || !name.trim()}><Plus size={16}/>创建并切换</button>
    </form>
    <p className="footnote">账户名称不可重复；单个账本最多 50 个账户（含已归档）。</p>
    {pendingDelete && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="delete-account-title" className="modal">
      <h2 id="delete-account-title">确认删除空账户「{pendingDelete.name}」？</h2>
      <p>删除后账户从列表中移除。只有没有任何交易记录（含已撤销）的账户可以删除；此操作不可撤销。</p>
      <div className="toolbar"><button autoFocus disabled={busy} onClick={() => setPendingDelete(null)}>取消</button><button className="danger" disabled={busy} onClick={() => void confirmDelete()}>{busy ? '正在删除…' : '确认删除'}</button></div>
    </section></div>}
  </section>;
}
