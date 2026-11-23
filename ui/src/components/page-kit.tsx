import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-2">
      <div className="min-w-0">
        {subtitle ? <p className="num text-muted-foreground text-xs">{subtitle}</p> : null}
        <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={className}>
      {title || description || actions ? (
        <CardHeader>
          {title ? <CardTitle className="text-base">{title}</CardTitle> : null}
          {description ? <CardDescription>{description}</CardDescription> : null}
          {actions ? <CardAction>{actions}</CardAction> : null}
        </CardHeader>
      ) : null}
      <CardPanel className={cn(title || description || actions ? undefined : 'p-6', 'space-y-4', bodyClassName)}>{children}</CardPanel>
    </Card>
  );
}

export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-3 sm:grid-cols-2 xl:grid-cols-4', className)}>{children}</div>;
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'positive' | 'negative' | 'warning';
}) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-xs/5">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p
        className={cn(
          'num mt-1 text-2xl font-semibold tracking-tight',
          tone === 'positive' && 'text-success-foreground',
          tone === 'negative' && 'text-destructive-foreground',
          tone === 'warning' && 'text-warning-foreground',
        )}
      >
        {value}
      </p>
      {hint ? <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p> : null}
    </div>
  );
}

export function Footnote({ children }: { children: ReactNode }) {
  return <p className="footnote text-muted-foreground max-w-[72ch] text-xs leading-relaxed">{children}</p>;
}

export function KeyValue({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <strong className="num text-sm font-medium">{value}</strong>
      {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
    </div>
  );
}

export function Amount({ value, tone, className }: { value: ReactNode; tone?: 'positive' | 'negative' | 'warning'; className?: string }) {
  return (
    <span
      className={cn(
        'num',
        tone === 'positive' && 'text-success-foreground',
        tone === 'negative' && 'text-destructive-foreground',
        tone === 'warning' && 'text-warning-foreground',
        className,
      )}
    >
      {value}
    </span>
  );
}
