'use client';

import {
  CheckCircle2,
  CircleAlert,
  CircleSlash,
  Copy,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { PageHeader } from '@/app/playground/_components/PageHeader';
import { Panel, PanelBody, PanelHeader } from '@/app/playground/_components/Panel';

interface ProbeResult {
  service: string;
  status: 'up' | 'down' | 'unconfigured';
  latencyMs: number | null;
  message: string | null;
  detail?: Record<string, unknown> | null;
  checkedAt: string;
}

interface HealthResponse {
  probes: ProbeResult[];
  generatedAt: string;
}

const SERVICE_META: Record<
  string,
  { title: string; subtitle: string; href?: string }
> = {
  'fire-enrich-web': {
    title: 'fire-enrich web',
    subtitle: 'This dashboard. Always reports up if you can read this.',
  },
  'fire-enrich-db': {
    title: 'fire-enrich postgres',
    subtitle: 'Drizzle DB backing principals, BYOK keys, usage events.',
  },
  'firecrawl-api': {
    title: 'firecrawl api',
    subtitle: 'Self-hosted Firecrawl HTTP API.',
    href: '/admin/ops/firecrawl',
  },
  'firecrawl-redis': {
    title: 'firecrawl redis',
    subtitle: 'BullMQ broker for crawl + research + billing queues.',
    href: '/admin/ops/firecrawl',
  },
  'firecrawl-playwright': {
    title: 'firecrawl playwright',
    subtitle: 'Browser pool. Probed via feng-check end-to-end scrape.',
    href: '/admin/ops/firecrawl',
  },
  'firecrawl-mcp': {
    title: 'firecrawl-mcp',
    subtitle: 'The self-hosted MCP server you can wire into Claude Code / OpenCode.',
    href: '/admin/ops/mcp',
  },
};

const REFRESH_MS = 10_000;

export function OpsStackView() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch('/api/admin/ops/health', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as HealthResponse;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const summary = summarize(data?.probes);

  return (
    <div className="flex min-h-svh flex-col">
      <PageHeader
        title="Stack"
        subtitle="Health of every component in the self-hosted Fire Enrich stack."
        endpoint={
          summary
            ? `${summary.up}/${summary.total} up · ${summary.unconfigured} unconfigured`
            : 'probing…'
        }
        right={
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void load();
            }}
            className="inline-flex h-32 items-center gap-6 rounded-8 border border-border-muted bg-accent-white px-12 text-label-medium font-medium text-accent-black transition-colors hover:bg-black-alpha-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-heat-40"
          >
            <RefreshCw className={`h-14 w-14 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      />

      <div className="flex-1 px-24 pb-48 pt-24">
        <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-20">
          {error && (
            <div
              role="alert"
              className="rounded-10 border border-accent-crimson p-16 text-body-small text-accent-crimson"
              style={{ backgroundColor: 'rgba(235, 52, 36, 0.06)' }}
            >
              {error}
            </div>
          )}

          {data ? (
            <div className="grid grid-cols-1 gap-16 md:grid-cols-2">
              {data.probes.map((p) => (
                <ProbeCard key={p.service} probe={p} />
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center rounded-12 border border-border-muted bg-background-lighter p-48 text-body-small text-black-alpha-56">
              <Loader2 className="mr-8 h-16 w-16 animate-spin text-heat-100" />
              Probing services…
            </div>
          )}

          <ComposeSnippet />
        </div>
      </div>
    </div>
  );
}

function summarize(probes: ProbeResult[] | undefined) {
  if (!probes) return null;
  const total = probes.length;
  const up = probes.filter((p) => p.status === 'up').length;
  const unconfigured = probes.filter((p) => p.status === 'unconfigured').length;
  return { total, up, unconfigured };
}

function ProbeCard({ probe }: { probe: ProbeResult }) {
  const meta = SERVICE_META[probe.service] ?? {
    title: probe.service,
    subtitle: '',
  };

  const tone =
    probe.status === 'up'
      ? 'forest'
      : probe.status === 'unconfigured'
        ? 'muted'
        : 'crimson';

  return (
    <div className="overflow-hidden rounded-12 border border-border-muted bg-accent-white">
      <div className="flex items-center justify-between gap-12 border-b border-border-faint bg-background-lighter px-16 py-12">
        <div className="flex min-w-0 flex-col gap-2">
          <h2 className="truncate text-body-small font-semibold tracking-tight text-accent-black">
            {meta.title}
          </h2>
          <p className="truncate text-body-small text-black-alpha-56">
            {meta.subtitle}
          </p>
        </div>
        <StatusBadge tone={tone} status={probe.status} />
      </div>
      <div className="flex flex-col gap-10 px-16 py-12">
        <Row
          label="Latency"
          value={
            probe.latencyMs == null ? (
              <Dim>—</Dim>
            ) : (
              <span className="font-mono text-mono-small">
                {probe.latencyMs} ms
              </span>
            )
          }
        />
        <Row
          label="Last checked"
          value={
            <span className="font-mono text-mono-small text-black-alpha-72">
              {formatTime(probe.checkedAt)}
            </span>
          }
        />
        {probe.message && (
          <Row
            label="Message"
            value={
              <span className="break-words text-body-small text-black-alpha-72">
                {probe.message}
              </span>
            }
          />
        )}
        {meta.href && (
          <div className="pt-4">
            <Link
              href={meta.href}
              className="text-body-small font-medium text-heat-100 underline decoration-heat-40 underline-offset-2 transition-colors hover:decoration-heat-100"
            >
              Details →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({
  tone,
  status,
}: {
  tone: 'forest' | 'crimson' | 'muted';
  status: ProbeResult['status'];
}) {
  if (tone === 'forest') {
    return (
      <span
        className="inline-flex items-center gap-6 rounded-full px-10 py-2 text-label-x-small font-medium text-accent-forest"
        style={{ backgroundColor: 'rgba(66, 195, 102, 0.10)' }}
      >
        <CheckCircle2 className="h-12 w-12" />
        Up
      </span>
    );
  }
  if (tone === 'crimson') {
    return (
      <span
        className="inline-flex items-center gap-6 rounded-full px-10 py-2 text-label-x-small font-medium text-accent-crimson"
        style={{ backgroundColor: 'rgba(235, 52, 36, 0.10)' }}
      >
        <CircleAlert className="h-12 w-12" />
        Down
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-6 rounded-full bg-black-alpha-5 px-10 py-2 text-label-x-small font-medium text-black-alpha-56">
      <CircleSlash className="h-12 w-12" />
      {status === 'unconfigured' ? 'Not configured' : status}
    </span>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-12 text-body-small">
      <span className="w-[88px] shrink-0 text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-48">
        {label}
      </span>
      <span className="min-w-0 flex-1">{value}</span>
    </div>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-black-alpha-32">{children}</span>;
}

function formatTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString();
  } catch {
    return iso;
  }
}

const COMPOSE_SNIPPET = `# Append to firecrawl/docker-compose.yaml. Wildcard *.theochinomona.tech
# already lives in your Cloudflare zone, so no new DNS records — just the
# Traefik labels + the cf-access-verifier sidecar that fronts both apps.
#
#   enrich.theochinomona.tech  → fire-enrich-web  (the dashboard)
#   crawl.theochinomona.tech/mcp → firecrawl-mcp  (path-routed; existing
#                                                  Firecrawl API on /v1, /v2,
#                                                  /admin/{key}/* untouched)

cf-access-verifier:
  build: ../fire-enrich/services/cf-access-verifier
  networks: [backend]
  environment:
    CF_ACCESS_TEAM: \${CF_ACCESS_TEAM}
    CF_ACCESS_AUDS: dashboard:\${CF_ACCESS_AUD_DASHBOARD},mcp:\${CF_ACCESS_AUD_MCP}

fire-enrich-web:
  build: ../fire-enrich/apps/web
  networks: [backend]
  labels:
    - "traefik.enable=true"
    - "traefik.http.routers.fe-web.rule=Host(\`enrich.theochinomona.tech\`)"
    - "traefik.http.routers.fe-web.entrypoints=websecure"
    - "traefik.http.routers.fe-web.tls.certresolver=cloudflare"
    - "traefik.http.routers.fe-web.middlewares=cf-access-dashboard@docker"
    - "traefik.http.services.fe-web.loadbalancer.server.port=3000"
    - "traefik.http.middlewares.cf-access-dashboard.forwardauth.address=http://cf-access-verifier:8080/verify?aud=dashboard"
    - "traefik.http.middlewares.cf-access-dashboard.forwardauth.authResponseHeaders=X-Auth-User-Email,X-Auth-User-Sub"
  environment:
    OPS_AUTH_MODE: proxy
    OPERATOR_EMAILS: \${OPERATOR_EMAILS}
    DATABASE_URL: \${FIRE_ENRICH_DATABASE_URL}
    FIRECRAWL_INTERNAL_URL: http://api:3002
    FIRECRAWL_API_URL: http://api:3002
    BULL_AUTH_KEY: \${BULL_AUTH_KEY}
    MCP_INTERNAL_URL: http://firecrawl-mcp:3000
    KEY_ENCRYPTION_KEY: \${KEY_ENCRYPTION_KEY}
    SERVER_PEPPER: \${SERVER_PEPPER}
  depends_on: [api, firecrawl-mcp, cf-access-verifier]

firecrawl-mcp:
  build: ../firecrawl-mcp-server
  networks: [backend]
  labels:
    - "traefik.enable=true"
    # priority > 1 so PathPrefix(\`/mcp\`) wins over the api's host-only rule
    - "traefik.http.routers.fc-mcp.rule=Host(\`crawl.theochinomona.tech\`) && PathPrefix(\`/mcp\`)"
    - "traefik.http.routers.fc-mcp.priority=100"
    - "traefik.http.routers.fc-mcp.entrypoints=websecure"
    - "traefik.http.routers.fc-mcp.tls.certresolver=cloudflare"
    - "traefik.http.routers.fc-mcp.middlewares=cf-access-mcp@docker"
    - "traefik.http.services.fc-mcp.loadbalancer.server.port=3000"
    - "traefik.http.middlewares.cf-access-mcp.forwardauth.address=http://cf-access-verifier:8080/verify?aud=mcp"
    - "traefik.http.middlewares.cf-access-mcp.forwardauth.authResponseHeaders=X-Auth-User-Email,X-Auth-User-Sub"
  environment:
    HTTP_STREAMABLE_SERVER: "true"
    PORT: "3000"
    HOST: "0.0.0.0"
    FIRECRAWL_API_URL: http://api:3002
    LLM_API_KEY: \${LLM_API_KEY}
    LLM_BASE_URL: \${LLM_BASE_URL}
  depends_on: [api, cf-access-verifier]

# In Cloudflare Zero Trust → Access → Applications, create two apps:
#   1. enrich-dashboard  →  enrich.theochinomona.tech   (humans only)
#   2. firecrawl-mcp     →  crawl.theochinomona.tech/mcp (humans + service
#                                                         tokens for
#                                                         OpenCode / Claude
#                                                         Code clients)
# Copy each application's Audience tag into CF_ACCESS_AUD_DASHBOARD and
# CF_ACCESS_AUD_MCP. The existing Firecrawl API at crawl.theochinomona.tech
# stays exactly as it is — only the /mcp subpath gets the new gate.
`;

function ComposeSnippet() {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    navigator.clipboard.writeText(COMPOSE_SNIPPET).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Panel>
      <PanelHeader
        title="docker-compose snippet"
        right={
          <button
            type="button"
            onClick={onCopy}
            className="inline-flex h-28 items-center gap-6 rounded-6 border border-border-muted bg-accent-white px-10 text-label-medium font-medium text-accent-black transition-colors hover:bg-black-alpha-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-heat-40"
          >
            <Copy className="h-12 w-12" />
            {copied ? 'Copied' : 'Copy'}
          </button>
        }
      />
      <PanelBody>
        <p className="mb-12 text-body-small text-black-alpha-72">
          Append this to <span className="font-mono text-mono-small text-accent-black">firecrawl/docker-compose.yaml</span>{' '}
          and re-run <span className="font-mono text-mono-small text-accent-black">docker compose up -d</span>{' '}
          to bring fire-enrich and the MCP up on the same backend network. The
          dashboard reaches them by internal hostname so secrets stay off the public side.
        </p>
        <pre className="overflow-x-auto rounded-8 border border-border-muted bg-[#0f1014] p-16 font-mono text-mono-x-small leading-[18px] text-[#e6e6e6]">
{COMPOSE_SNIPPET}
        </pre>
      </PanelBody>
    </Panel>
  );
}
