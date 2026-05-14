import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  endpoint?: string;
  right?: ReactNode;
}

export function PageHeader({ title, subtitle, endpoint, right }: PageHeaderProps) {
  return (
    <header className="sticky top-0 z-10 border-b border-border-faint bg-background-base">
      <div className="flex h-64 items-end justify-between gap-24 px-24 pb-12 pt-20">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-10">
            <h1 className="text-title-h5 font-semibold tracking-tight text-accent-black">
              {title}
            </h1>
            {endpoint && (
              <span className="inline-flex items-center rounded-full border border-border-muted bg-background-lighter px-8 py-2 font-mono text-mono-x-small text-black-alpha-72">
                {endpoint}
              </span>
            )}
          </div>
          {subtitle && (
            <p className="text-body-small text-black-alpha-56">{subtitle}</p>
          )}
        </div>
        {right && <div className="flex items-center gap-12">{right}</div>}
      </div>
    </header>
  );
}
