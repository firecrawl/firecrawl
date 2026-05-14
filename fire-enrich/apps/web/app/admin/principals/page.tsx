import { listPrincipals, getDb } from '@fire-enrich/db';
import { Users } from 'lucide-react';

import { toPrincipalSummary, type PrincipalSummary } from '@/lib/admin-types';
import { PageHeader } from '@/app/playground/_components/PageHeader';
import { Panel } from '@/app/playground/_components/Panel';

import { NewPrincipalDialog } from './new-principal-dialog';
import { RevokeButton } from './revoke-button';

export const metadata = {
  title: 'Principals · Fire Enrich admin',
};

export const dynamic = 'force-dynamic';

export default async function AdminPrincipalsPage() {
  const db = getDb();
  const rows = await listPrincipals(db);
  const principals = rows.map(toPrincipalSummary);

  const total = principals.length;
  const active = principals.filter((p) => !p.revokedAt).length;

  return (
    <div className="flex min-h-svh flex-col">
      <PageHeader
        title="Principals"
        endpoint={`${total} total · ${active} active`}
        subtitle="Per-tenant bearer tokens with optional BYOK and monthly quotas."
        right={<NewPrincipalDialog />}
      />

      <div className="flex-1 px-24 pb-48 pt-24">
        <div className="mx-auto w-full max-w-[1200px]">
          {principals.length === 0 ? (
            <EmptyState />
          ) : (
            <Panel>
              <div className="overflow-x-auto">
                <table className="w-full border-separate border-spacing-0 text-left">
                  <thead className="bg-background-lighter">
                    <tr>
                      <Th>Label</Th>
                      <Th>Token prefix</Th>
                      <Th>Created</Th>
                      <Th>Status</Th>
                      <Th align="right">Quota (FC)</Th>
                      <Th align="right">Quota (OAI)</Th>
                      <Th>BYOK</Th>
                      <Th align="right">Actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {principals.map((p, i) => (
                      <PrincipalRow key={p.id} principal={p} isLast={i === principals.length - 1} />
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-12 rounded-12 border border-dashed border-border-muted bg-accent-white px-24 py-48 text-center">
      <span className="flex h-44 w-44 items-center justify-center rounded-full bg-heat-12 text-heat-100">
        <Users className="h-20 w-20" />
      </span>
      <div className="flex flex-col gap-4">
        <h2 className="text-body-large font-semibold tracking-tight text-accent-black">
          No principals yet
        </h2>
        <p className="max-w-[420px] text-body-small text-black-alpha-72">
          Each principal gets its own bearer token, monthly quota, and optional BYOK keys. Click <span className="font-medium text-accent-black">New principal</span> in the header to provision one.
        </p>
      </div>
    </div>
  );
}

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={[
        'border-b border-border-faint px-16 py-12',
        'text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56',
        align === 'right' ? 'text-right' : 'text-left',
      ].join(' ')}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
  isLast,
  className = '',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  isLast: boolean;
  className?: string;
}) {
  return (
    <td
      className={[
        'px-16 py-12 align-middle text-body-small',
        isLast ? '' : 'border-b border-border-faint',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      ].join(' ')}
    >
      {children}
    </td>
  );
}

function PrincipalRow({
  principal: p,
  isLast,
}: {
  principal: PrincipalSummary;
  isLast: boolean;
}) {
  const isRevoked = !!p.revokedAt;
  return (
    <tr className={isRevoked ? 'opacity-60' : 'transition-colors hover:bg-background-lighter'}>
      <Td isLast={isLast} className="font-medium text-accent-black">
        {p.label}
      </Td>
      <Td isLast={isLast}>
        <span className="font-mono text-mono-small text-accent-black">{p.tokenPrefix}</span>
      </Td>
      <Td isLast={isLast} className="text-black-alpha-72">
        <time dateTime={p.createdAt}>{formatDate(p.createdAt)}</time>
      </Td>
      <Td isLast={isLast}>
        {isRevoked ? (
          <StatusPill tone="muted">Revoked</StatusPill>
        ) : (
          <StatusPill tone="forest">Active</StatusPill>
        )}
      </Td>
      <Td isLast={isLast} align="right" className="font-mono text-mono-small">
        {p.quotaFirecrawlMonth ? p.quotaFirecrawlMonth.limit.toLocaleString() : <Dim>—</Dim>}
      </Td>
      <Td isLast={isLast} align="right" className="font-mono text-mono-small">
        {p.quotaOpenaiMonth ? p.quotaOpenaiMonth.limit.toLocaleString() : <Dim>—</Dim>}
      </Td>
      <Td isLast={isLast}>
        <ByokBadges p={p} />
      </Td>
      <Td isLast={isLast} align="right">
        {isRevoked ? (
          <Dim>—</Dim>
        ) : (
          <RevokeButton id={p.id} label={p.label} />
        )}
      </Td>
    </tr>
  );
}

function ByokBadges({ p }: { p: PrincipalSummary }) {
  if (!p.hasByokFirecrawl && !p.hasByokOpenai) {
    return <span className="text-body-small text-black-alpha-56">pooled</span>;
  }
  return (
    <span className="inline-flex items-center gap-6 font-mono text-mono-small">
      <Badge tone={p.hasByokFirecrawl ? 'forest' : 'muted'}>FC</Badge>
      <Badge tone={p.hasByokOpenai ? 'forest' : 'muted'}>OAI</Badge>
    </span>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: 'forest' | 'muted' }) {
  if (tone === 'forest') {
    return (
      <span
        className="inline-flex items-center rounded-4 px-6 py-1 text-mono-x-small font-medium text-accent-forest"
        style={{ backgroundColor: 'rgba(66, 195, 102, 0.10)' }}
      >
        {children}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-4 bg-black-alpha-5 px-6 py-1 text-mono-x-small font-medium text-black-alpha-56">
      {children}
    </span>
  );
}

function StatusPill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: 'forest' | 'muted';
}) {
  if (tone === 'forest') {
    return (
      <span
        className="inline-flex items-center gap-6 rounded-full px-8 py-2 text-label-x-small font-medium text-accent-forest"
        style={{ backgroundColor: 'rgba(66, 195, 102, 0.10)' }}
      >
        <span className="block h-6 w-6 rounded-full bg-accent-forest" />
        {children}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-6 rounded-full bg-black-alpha-5 px-8 py-2 text-label-x-small font-medium text-black-alpha-56">
      <span className="block h-6 w-6 rounded-full bg-black-alpha-32" />
      {children}
    </span>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-black-alpha-32">{children}</span>;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
