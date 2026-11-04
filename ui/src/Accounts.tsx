import { useState, type FormEvent } from 'react';
import { Check, Pencil, Plus, X } from 'lucide-react';
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

  async function refresh() {
    onAccounts(await api<Account[]>('list_accounts'));
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

  return <section className="panel account-panel">
    <div className="section-heading"><h2>账户</h2><span className="muted">每个账户有独立账本、持仓与成本</span></div>
    <p className="muted">切换账户只会改变当前查看的账本，不会合并数据。行情报价与成本口径为全局设置。</p>
    <div className="table-wrap"><table><thead><tr><th>名称</th><th>币种</th><th>建立日期</th><th>操作</th></tr></thead><tbody>
      {accounts.map(account => <tr key={account.id}>
        <td>{renaming === account.id
          ? <input aria-label={`重命名 ${account.name}`} autoFocus maxLength={40} value={renameValue} onChange={event => setRenameValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void saveRename(account); if (event.key === 'Escape') setRenaming(null); }}/>
          : <>{account.name}{account.id === currentId && <span className="badge active">当前</span>}</>}</td>
        <td>{account.currency}</td>
        <td>{account.createdAt}</td>
        <td><div className="toolbar">
          {renaming === account.id
            ? <><button aria-label="保存名称" disabled={busy || !renameValue.trim()} onClick={() => void saveRename(account)}><Check size={15}/>保存</button><button aria-label="取消重命名" onClick={() => setRenaming(null)}><X size={15}/>取消</button></>
            : <><button disabled={busy || account.id === currentId} onClick={() => onSwitch(account.id)}>{account.id === currentId ? '使用中' : '切换'}</button><button aria-label={`重命名 ${account.name}`} disabled={busy} onClick={() => beginRename(account)}><Pencil size={15}/>重命名</button></>}
        </div></td>
      </tr>)}
    </tbody></table></div>
    {!accounts.length && <p className="empty">还没有账户。</p>}
    <form className="account-create" onSubmit={create}>
      <label>新账户名称<input required maxLength={40} placeholder="例如：长期账户" value={name} onChange={event => setName(event.target.value)}/></label>
      <button type="submit" className="primary" disabled={busy || !name.trim()}><Plus size={16}/>创建并切换</button>
    </form>
    <p className="footnote">账户名称不可重复；单个账本最多 50 个账户。</p>
  </section>;
}
