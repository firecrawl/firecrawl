'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Activity,
  FileSpreadsheet,
  Flame,
  Globe,
  KeyRound,
  Layers,
  ListTree,
  Map as MapIcon,
  Plug,
  Search,
  Sparkles,
  Users,
} from 'lucide-react';

import { TOKEN_STORAGE_KEY, TokenDialog } from './TokenDialog';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const playgroundItems: NavItem[] = [
  { href: '/playground/scrape', label: 'Scrape', icon: Globe },
  { href: '/playground/crawl', label: 'Crawl', icon: Layers },
  { href: '/playground/search', label: 'Search', icon: Search },
  { href: '/playground/map', label: 'Map', icon: MapIcon },
  { href: '/playground/extract', label: 'Extract', icon: Sparkles },
  { href: '/playground/batch-scrape', label: 'Batch Scrape', icon: ListTree },
];

const enrichmentItems: NavItem[] = [
  { href: '/fire-enrich', label: 'CSV Enrichment', icon: FileSpreadsheet },
];

const operationsItems: NavItem[] = [
  { href: '/admin/ops', label: 'Stack', icon: Activity },
  { href: '/admin/ops/firecrawl', label: 'Firecrawl', icon: Flame },
  { href: '/admin/ops/mcp', label: 'MCP', icon: Plug },
];

const adminItems: NavItem[] = [
  { href: '/admin/principals', label: 'Principals', icon: Users },
];

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (pathname === href) return true;
  return pathname.startsWith(`${href}/`);
}

function NavSection({
  label,
  items,
  pathname,
}: {
  label: string;
  items: NavItem[];
  pathname: string | null;
}) {
  return (
    <div className="px-12 pt-16 pb-4">
      <div className="px-12 pb-8 text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-48">
        {label}
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((item) => {
          const Icon = item.icon;
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={[
                  'group relative flex items-center gap-12 rounded-8 px-12 py-8',
                  'text-body-small transition-colors duration-150',
                  active
                    ? 'bg-heat-8 text-heat-100 font-medium'
                    : 'text-black-alpha-72 hover:bg-black-alpha-5 hover:text-accent-black',
                ].join(' ')}
              >
                <Icon
                  className={[
                    'h-16 w-16 shrink-0 transition-colors',
                    active ? 'text-heat-100' : 'text-black-alpha-56 group-hover:text-accent-black',
                  ].join(' ')}
                />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [tokenPreview, setTokenPreview] = useState<string | null>(null);
  const hasToken = tokenPreview !== null && tokenPreview.length > 0;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    setTokenPreview(stored);
  }, [tokenDialogOpen]);

  const previewText = hasToken
    ? tokenPreview!.slice(0, 12) + (tokenPreview!.length > 12 ? '…' : '')
    : 'No token set';

  return (
    <>
      <aside className="sticky top-0 hidden h-svh w-240 shrink-0 flex-col border-r border-border-faint bg-background-lighter md:flex">
        <div className="flex h-56 items-center gap-10 px-16 border-b border-border-faint">
          <span className="block h-10 w-10 rounded-full bg-heat-100 shadow-[0_0_0_3px_var(--heat-12)]" />
          <span className="text-body-small font-semibold tracking-tight text-accent-black">
            Fire Enrich
          </span>
        </div>

        <nav className="flex-1 overflow-y-auto pb-16">
          <NavSection label="Playground" items={playgroundItems} pathname={pathname} />
          <NavSection label="Enrichment" items={enrichmentItems} pathname={pathname} />
          <NavSection label="Operations" items={operationsItems} pathname={pathname} />
          <NavSection label="Admin" items={adminItems} pathname={pathname} />
        </nav>

        <div className="border-t border-border-faint p-12">
          <button
            type="button"
            onClick={() => setTokenDialogOpen(true)}
            className={[
              'group flex w-full items-center gap-12 rounded-8 px-12 py-10',
              'text-left transition-colors duration-150',
              'hover:bg-black-alpha-5',
            ].join(' ')}
          >
            <span
              className={[
                'flex h-24 w-24 shrink-0 items-center justify-center rounded-6',
                hasToken ? 'text-accent-forest' : 'bg-black-alpha-6 text-black-alpha-56',
              ].join(' ')}
              style={hasToken ? { backgroundColor: 'rgba(66, 195, 102, 0.10)' } : undefined}
            >
              <KeyRound className="h-12 w-12" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-label-x-small uppercase tracking-[0.06em] text-black-alpha-48">
                API token
              </span>
              <span
                className={[
                  'truncate font-mono text-mono-small',
                  hasToken ? 'text-accent-black' : 'text-black-alpha-56',
                ].join(' ')}
              >
                {previewText}
              </span>
            </span>
          </button>
        </div>
      </aside>

      <TokenDialog
        open={tokenDialogOpen}
        onOpenChange={setTokenDialogOpen}
        onSaved={(t) => setTokenPreview(t)}
      />
    </>
  );
}
