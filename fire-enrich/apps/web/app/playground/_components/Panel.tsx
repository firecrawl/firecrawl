import type { ReactNode } from 'react';

import { cn } from '@/utils/cn';

interface PanelProps {
  children: ReactNode;
  className?: string;
}

export function Panel({ children, className }: PanelProps) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-12 border border-border-muted bg-accent-white',
        'shadow-[0_1px_0_0_rgba(0,0,0,0.02)]',
        className,
      )}
    >
      {children}
    </section>
  );
}

interface PanelHeaderProps {
  title: ReactNode;
  right?: ReactNode;
  className?: string;
}

export function PanelHeader({ title, right, className }: PanelHeaderProps) {
  return (
    <header
      className={cn(
        'flex h-44 items-center justify-between gap-12 border-b border-border-faint bg-background-lighter px-16',
        className,
      )}
    >
      <h2 className="text-body-small font-semibold tracking-tight text-accent-black">
        {title}
      </h2>
      {right ? <div className="flex items-center gap-12">{right}</div> : null}
    </header>
  );
}

interface PanelBodyProps {
  children: ReactNode;
  className?: string;
}

export function PanelBody({ children, className }: PanelBodyProps) {
  return <div className={cn('p-16', className)}>{children}</div>;
}
