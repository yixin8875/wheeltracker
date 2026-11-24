import { ChevronRightIcon, ListTodoIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import type { InsightAction, InsightItem, InsightSeverity, TodoView } from './types';

const severityTone: Record<InsightSeverity, string> = {
  urgent: 'border-destructive/40 bg-destructive/5',
  warning: 'border-warning/40 bg-warning/5',
  info: 'border-border bg-muted/30',
};

const severityBadge: Record<InsightSeverity, 'destructive' | 'warning' | 'secondary'> = {
  urgent: 'destructive',
  warning: 'warning',
  info: 'secondary',
};

const actionLabel: Record<InsightAction, string> = {
  expire: '标记作废',
  close: '平仓',
  roll: '滚动',
  cost: '降本方案',
  cash: '现金对账',
};

export function TodoCard({ todos, onAction, onOpenExpiry }: {
  todos: TodoView | null;
  onAction: (item: InsightItem) => void;
  onOpenExpiry: () => void;
}) {
  const items = todos?.items ?? [];
  const rules = todos?.rules;
  return (
    <Card className="todo-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListTodoIcon className="size-4 text-muted-foreground" />
          今日待办
          {items.length > 0 && <Badge variant={items.some(item => item.severity === 'urgent') ? 'destructive' : 'warning'} size="sm">{items.length}</Badge>}
        </CardTitle>
        <CardDescription>
          {rules
            ? `到期 ${rules.expiryDays} 天内 · 权利金剩余 ≤ ${rules.profitTargetPct}% · 深度实值 ${rules.deepItmPct}% · 低于 B 轨成本 ${rules.belowCostPct}%`
            : '规则驱动，汇总需要处理的合约与现金事项'}
        </CardDescription>
      </CardHeader>
      <CardPanel className="space-y-2">
        {!items.length ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>今天没有需要处理的合约</EmptyTitle>
              <EmptyDescription>临近到期、权利金收回、深度实值、现金不足或股价跌破成本时会出现在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {items.slice(0, 6).map(item => (
              <div
                key={item.id}
                className={`todo-row flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 ${severityTone[item.severity]}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm font-medium">{item.contract ?? item.symbol}</strong>
                    <Badge variant={severityBadge[item.severity]} size="sm">{item.title}</Badge>
                    <span className="text-xs text-muted-foreground">{item.accountName}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
                </div>
                <Button
                  size="xs"
                  variant={item.severity === 'urgent' ? 'destructive' : 'outline'}
                  onClick={() => onAction(item)}
                >
                  {actionLabel[item.action]}
                </Button>
              </div>
            ))}
            {items.length > 6 && (
              <Button variant="link" size="sm" className="w-fit" onClick={onOpenExpiry}>
                另有 {items.length - 6} 条，去到期处理<ChevronRightIcon />
              </Button>
            )}
          </>
        )}
      </CardPanel>
    </Card>
  );
}
