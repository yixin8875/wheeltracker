import { useEffect, useState } from 'react';
import { ArrowRightIcon, LandmarkIcon, ListChecksIcon, SparklesIcon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, desktop, today } from './lib';

type Step = 'welcome' | 'deposit' | 'first';

export function OnboardingGuide({ open, accountId, accountName, onDeposited, onFinished, onStartEntry, onOpenAccount }: {
  open: boolean;
  accountId: string;
  accountName: string;
  onDeposited: () => Promise<unknown>;
  onFinished: () => void;
  onStartEntry: () => void;
  onOpenAccount: (accountId: string) => void;
}) {
  const [step, setStep] = useState<Step>('welcome');
  const [amount, setAmount] = useState(50000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setStep('welcome');
      setAmount(50000);
      setError('');
    }
  }, [open]);

  async function finish() {
    try { await api('complete_onboarding'); } catch { /* the guide can still close */ }
    onFinished();
  }

  async function deposit() {
    if (busy) return;
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('期初入金必须是大于 0 的金额。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('add_event', {
        req: {
          accountId,
          date: today(),
          kind: 'cash_deposit',
          symbol: '',
          qty: 0,
          price: 0,
          fees: 0,
          amount,
          note: '期初入金',
        },
      });
      await onDeposited();
      setStep('first');
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  async function createDemo() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const id = await api<string>('create_demo_account');
      await onDeposited();
      await finish();
      onOpenAccount(id);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !busy) void finish(); }}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><SparklesIcon className="size-4 text-muted-foreground" />欢迎使用 Wheel Tracker</DialogTitle>
          <DialogDescription>三步把账本跑起来：确认账户 → 记录期初入金 → 记第一笔交易。之后随时可以从「记一笔」继续。</DialogDescription>
        </DialogHeader>

        {error && <Alert variant="error" role="alert" className="negative">{error}</Alert>}

        {step === 'welcome' && (
          <div className="onboarding-steps grid gap-3">
            <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
              <LandmarkIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div><p className="text-sm font-medium">1. 确认账户</p><p className="text-xs text-muted-foreground">当前账户：{accountName}。多账户可在「设置 → 账户」里新建。</p></div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
              <ListChecksIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div><p className="text-sm font-medium">2. 记录期初入金</p><p className="text-xs text-muted-foreground">入金是账户资金划转，不属于收益；这样现金覆盖率和资金义务才有基准。</p></div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
              <ArrowRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div><p className="text-sm font-medium">3. 记第一笔交易</p><p className="text-xs text-muted-foreground">卖 Put 或买入股票后，系统会自动建立战役并追踪 A / B / C′ 成本。</p></div>
            </div>
            <p className="text-xs text-muted-foreground">不想手动录入？可以创建一个带示例数据的演示账户先看看。</p>
          </div>
        )}

        {step === 'deposit' && (
          <div className="space-y-3">
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              期初入金（USD）
              <Input
                aria-label="期初入金金额"
                type="number"
                min={0}
                step={100}
                className="max-w-48"
                value={amount}
                disabled={busy || !desktop}
                onChange={event => setAmount(Number(event.target.value))}
              />
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">按券商账户的实际可用现金填写。已经入过金可以跳过，之后在「记一笔 → 入金」补记。</p>
          </div>
        )}

        {step === 'first' && (
          <div className="space-y-3">
            <p className="text-sm">期初入金已记录。下一步可以：</p>
            <ul className="grid gap-1.5 text-xs text-muted-foreground">
              <li>· 点「记第一笔交易」录入卖出 Put 或股票买入；</li>
              <li>· 或打开演示账户，查看一轮完整的收租、平仓与报表；</li>
              <li>· 也可以先完成向导，之后从侧栏「记一笔」开始。</li>
            </ul>
          </div>
        )}

        <DialogFooter className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void finish()}>跳过向导</Button>
          <div className="flex flex-wrap gap-2">
            {step === 'welcome' && <Button onClick={() => setStep('deposit')}>下一步<ArrowRightIcon /></Button>}
            {step === 'deposit' && (
              <>
                <Button variant="outline" disabled={busy} onClick={() => setStep('first')}>暂时跳过</Button>
                <Button disabled={busy || !desktop} onClick={() => void deposit()}>{busy ? '保存中…' : '记录期初入金'}</Button>
              </>
            )}
            {step === 'first' && (
              <>
                <Button variant="outline" disabled={busy || !desktop} onClick={() => void createDemo()}>{busy ? '创建中…' : '查看演示账户'}</Button>
                <Button disabled={busy} onClick={() => { void finish(); onStartEntry(); }}>记第一笔交易</Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
