import type { ComponentProps } from 'react';
import { ChevronsUpDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Native <select> styled to match the coss select trigger.
 * Kept native so desktop keyboard/IME behaviour and `selectOption` automation
 * stay predictable inside the Tauri webview.
 */
export function NativeSelect({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <span className="relative inline-flex w-full items-center">
      <select
        className={cn(
          'h-8.5 w-full appearance-none rounded-lg border border-input bg-background px-[calc(--spacing(3)-1px)] pe-8 text-sm text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 disabled:pointer-events-none disabled:opacity-64 sm:h-7.5',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronsUpDownIcon className="pointer-events-none absolute end-2.5 size-4 opacity-70" />
    </span>
  );
}
