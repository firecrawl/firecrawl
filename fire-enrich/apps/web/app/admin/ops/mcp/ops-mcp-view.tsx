'use client';

import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleSlash,
  Copy,
  Loader2,
  Play,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { PageHeader } from '@/app/playground/_components/PageHeader';
import { Panel, PanelBody, PanelHeader } from '@/app/playground/_components/Panel';
import { PrimaryButton } from '@/app/playground/_components/PrimaryButton';
import { FormTextarea } from '@/app/playground/_components/form-primitives';

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

interface McpStatus {
  configured: boolean;
  health: {
    status: 'up' | 'down' | 'unknown';
    latencyMs: number | null;
    message: string | null;
  };
  tools: ToolDefinition[];
  toolListError?: string;
  generatedAt: string;
}

const REFRESH_MS = 10_000;

export function OpsMcpView() {
  const [data, setData] = useState<McpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await fetch('/api/admin/ops/mcp/status', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
      }
      setData((await res.json()) as McpStatus);
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

  return (
    <div className="flex min-h-svh flex-col">
      <PageHeader
        title="MCP server"
        subtitle="Self-hosted Firecrawl MCP. Status, tool surface, and a live test runner."
        endpoint={data ? `${data.tools.length} tools` : 'fetching…'}
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

          {data && <StatusCard status={data} />}
          {data && data.configured && <ClientConfigSnippet />}
          {data && data.tools.length > 0 && <ToolsList tools={data.tools} />}
          {data && data.toolListError && (
            <div className="rounded-10 border border-border-muted bg-background-lighter p-16 text-body-small text-black-alpha-72">
              <div className="font-medium text-accent-black">tools/list failed</div>
              <div className="mt-4 break-words font-mono text-mono-x-small">
                {data.toolListError}
              </div>
            </div>
          )}

          {!data && !error && (
            <div className="flex items-center justify-center rounded-12 border border-border-muted bg-background-lighter p-48 text-body-small text-black-alpha-56">
              <Loader2 className="mr-8 h-16 w-16 animate-spin text-heat-100" />
              Talking to MCP…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusCard({ status }: { status: McpStatus }) {
  const tone = !status.configured
    ? 'muted'
    : status.health.status === 'up'
      ? 'forest'
      : 'crimson';

  return (
    <Panel>
      <PanelHeader
        title="Server"
        right={<StatusBadge tone={tone} />}
      />
      <PanelBody>
        {!status.configured && (
          <p className="text-body-small text-black-alpha-72">
            <span className="font-mono text-mono-small text-accent-black">MCP_INTERNAL_URL</span>{' '}
            is not set. Add it to the fire-enrich web env (e.g.{' '}
            <span className="font-mono text-mono-small text-accent-black">http://firecrawl-mcp:3000</span>{' '}
            on the compose network) to enable everything below.
          </p>
        )}
        {status.configured && (
          <div className="grid grid-cols-2 gap-16 md:grid-cols-3">
            <Row
              label="Health"
              value={
                <span className="font-mono text-mono-small text-accent-black">
                  {status.health.status}
                </span>
              }
            />
            <Row
              label="Latency"
              value={
                status.health.latencyMs == null ? (
                  <Dim>—</Dim>
                ) : (
                  <span className="font-mono text-mono-small">{status.health.latencyMs} ms</span>
                )
              }
            />
            <Row
              label="Generated"
              value={
                <span className="font-mono text-mono-small text-black-alpha-72">
                  {new Date(status.generatedAt).toLocaleTimeString()}
                </span>
              }
            />
            {status.health.message && (
              <Row
                label="Message"
                value={
                  <span className="break-words text-body-small text-black-alpha-72">
                    {status.health.message}
                  </span>
                }
                wide
              />
            )}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

function StatusBadge({ tone }: { tone: 'forest' | 'crimson' | 'muted' }) {
  if (tone === 'forest') {
    return (
      <span
        className="inline-flex items-center gap-6 rounded-full px-10 py-2 text-label-x-small font-medium text-accent-forest"
        style={{ backgroundColor: 'rgba(66, 195, 102, 0.10)' }}
      >
        <CheckCircle2 className="h-12 w-12" /> Up
      </span>
    );
  }
  if (tone === 'crimson') {
    return (
      <span
        className="inline-flex items-center gap-6 rounded-full px-10 py-2 text-label-x-small font-medium text-accent-crimson"
        style={{ backgroundColor: 'rgba(235, 52, 36, 0.10)' }}
      >
        <CircleAlert className="h-12 w-12" /> Down
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-6 rounded-full bg-black-alpha-5 px-10 py-2 text-label-x-small font-medium text-black-alpha-56">
      <CircleSlash className="h-12 w-12" /> Not configured
    </span>
  );
}

function ClientConfigSnippet() {
  const snippet = useMemo(() => buildClientSnippet(), []);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<'claude' | 'opencode' | 'cursor'>('claude');

  const onCopy = () => {
    navigator.clipboard.writeText(snippet[tab]).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const tabs: Array<{ id: typeof tab; label: string }> = [
    { id: 'claude', label: 'Claude Code' },
    { id: 'opencode', label: 'OpenCode' },
    { id: 'cursor', label: 'Cursor' },
  ];

  return (
    <Panel>
      <PanelHeader
        title="Client config"
        right={
          <button
            type="button"
            onClick={onCopy}
            className="inline-flex h-28 items-center gap-6 rounded-6 border border-border-muted bg-accent-white px-10 text-label-medium font-medium text-accent-black transition-colors hover:bg-black-alpha-4"
          >
            <Copy className="h-12 w-12" />
            {copied ? 'Copied' : 'Copy'}
          </button>
        }
      />
      <PanelBody>
        <div className="mb-12 flex w-fit items-center gap-2 rounded-8 bg-black-alpha-4 p-3">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={[
                'inline-flex h-28 items-center rounded-6 px-12 text-label-medium font-medium transition-colors',
                tab === t.id
                  ? 'bg-accent-white text-accent-black shadow-[0_0_0_1px_var(--border-muted),0_1px_2px_0_rgba(0,0,0,0.04)]'
                  : 'text-black-alpha-56 hover:text-accent-black',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>
        <pre className="overflow-x-auto rounded-8 border border-border-muted bg-[#0f1014] p-16 font-mono text-mono-x-small leading-[18px] text-[#e6e6e6]">
{snippet[tab]}
        </pre>
        <p className="mt-12 text-body-small text-black-alpha-56">
          Replace <span className="font-mono text-mono-x-small text-accent-black">YOUR_HOST</span> with
          the public URL where the MCP HTTP server is reachable from your client. If you keep both
          the client and the MCP on the same host, the snippet works as-is.
        </p>
      </PanelBody>
    </Panel>
  );
}

function ToolsList({ tools }: { tools: ToolDefinition[] }) {
  return (
    <Panel>
      <PanelHeader title="Tools" />
      <ul className="divide-y divide-border-faint">
        {tools.map((tool) => (
          <ToolRow key={tool.name} tool={tool} />
        ))}
      </ul>
    </Panel>
  );
}

function ToolRow({ tool }: { tool: ToolDefinition }) {
  const [open, setOpen] = useState(false);
  const [argsRaw, setArgsRaw] = useState(() => buildSeed(tool));
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  const runTool = async () => {
    setError(null);
    setOutput(null);
    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = argsRaw.trim() ? JSON.parse(argsRaw) : {};
    } catch (err) {
      setError(`Args JSON invalid: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setRunning(true);
    try {
      const res = await fetch('/api/admin/ops/mcp/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: tool.name, args: parsedArgs }),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        setError(json.error ?? `HTTP ${res.status}`);
        setOutput(json);
      } else {
        setOutput(json.result ?? json);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-12 px-16 py-12 text-left transition-colors hover:bg-background-lighter"
      >
        {open ? (
          <ChevronDown className="mt-2 h-14 w-14 shrink-0 text-black-alpha-56" />
        ) : (
          <ChevronRight className="mt-2 h-14 w-14 shrink-0 text-black-alpha-56" />
        )}
        <span className="flex min-w-0 flex-col gap-4">
          <span className="font-mono text-mono-small text-accent-black">{tool.name}</span>
          {tool.description && (
            <span className="line-clamp-2 text-body-small text-black-alpha-72">
              {firstSentence(tool.description)}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="border-t border-border-faint bg-background-lighter px-16 py-16">
          {tool.description && (
            <p className="mb-12 whitespace-pre-line text-body-small text-black-alpha-72">
              {tool.description}
            </p>
          )}
          {tool.inputSchema?.properties && (
            <SchemaTable schema={tool.inputSchema} />
          )}
          <div className="mt-16 flex flex-col gap-8">
            <label
              htmlFor={`args-${tool.name}`}
              className="text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56"
            >
              Arguments (JSON)
            </label>
            <FormTextarea
              id={`args-${tool.name}`}
              rows={6}
              value={argsRaw}
              onChange={(e) => setArgsRaw(e.target.value)}
              disabled={running}
            />
            <div className="flex justify-end">
              <PrimaryButton
                type="button"
                onClick={runTool}
                disabled={running}
                className="h-32 px-14"
              >
                {running ? (
                  <>
                    <Loader2 className="h-14 w-14 animate-spin" />
                    Running…
                  </>
                ) : (
                  <>
                    <Play className="h-14 w-14" />
                    Run
                  </>
                )}
              </PrimaryButton>
            </div>
            {error && (
              <div
                role="alert"
                className="rounded-8 border border-accent-crimson p-12 text-body-small text-accent-crimson"
                style={{ backgroundColor: 'rgba(235, 52, 36, 0.06)' }}
              >
                {error}
              </div>
            )}
            {output !== null && output !== undefined && (
              <pre className="overflow-x-auto rounded-8 border border-border-muted bg-[#0f1014] p-12 font-mono text-mono-x-small leading-[18px] text-[#e6e6e6]">
{JSON.stringify(output, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function SchemaTable({ schema }: { schema: NonNullable<ToolDefinition['inputSchema']> }) {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const rows = Object.entries(props);
  if (rows.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-8 border border-border-faint">
      <table className="w-full text-left">
        <thead className="bg-accent-white">
          <tr>
            <th className="px-12 py-8 text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56">
              Field
            </th>
            <th className="px-12 py-8 text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56">
              Type
            </th>
            <th className="px-12 py-8 text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56">
              Required
            </th>
            <th className="px-12 py-8 text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-56">
              Description
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, info], i) => (
            <tr key={name} className={i === rows.length - 1 ? '' : 'border-b border-border-faint'}>
              <td className="px-12 py-8 align-top font-mono text-mono-small text-accent-black">{name}</td>
              <td className="px-12 py-8 align-top font-mono text-mono-x-small text-black-alpha-72">
                {info.type ?? 'any'}
              </td>
              <td className="px-12 py-8 align-top text-body-small text-black-alpha-72">
                {required.has(name) ? 'yes' : '—'}
              </td>
              <td className="px-12 py-8 align-top text-body-small text-black-alpha-72">
                {info.description ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  label,
  value,
  wide,
}: {
  label: string;
  value: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-2 ${wide ? 'col-span-full' : ''}`}>
      <span className="text-label-x-small font-medium uppercase tracking-[0.06em] text-black-alpha-48">
        {label}
      </span>
      <span>{value}</span>
    </div>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-black-alpha-32">{children}</span>;
}

function firstSentence(s: string): string {
  const trimmed = s.trim();
  const idx = trimmed.search(/\.\s|\n/);
  if (idx === -1) return trimmed.slice(0, 200);
  return trimmed.slice(0, idx + 1);
}

function buildSeed(tool: ToolDefinition): string {
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const seed: Record<string, unknown> = {};
  for (const [name, info] of Object.entries(props)) {
    if (!required.has(name)) continue;
    seed[name] = sample(info?.type);
  }
  return JSON.stringify(seed, null, 2);
}

function sample(type: string | undefined): unknown {
  switch (type) {
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return null;
  }
}

function buildClientSnippet(): Record<'claude' | 'opencode' | 'cursor', string> {
  // Replace these in your local config — the dashboard knows the public
  // URL but Cloudflare Access service-token IDs are issued per-client and
  // are not appropriate to inline here.
  const url = 'https://crawl.theochinomona.tech/mcp';
  const principal = 'fe_xxx_replace_with_a_token_from_/admin/principals';

  const claude = `{
  "mcpServers": {
    "firecrawl-self-hosted": {
      "type": "http",
      "url": "${url}",
      "headers": {
        "Authorization": "Bearer ${principal}",
        "CF-Access-Client-Id": "<service-token-id>",
        "CF-Access-Client-Secret": "<service-token-secret>"
      }
    }
  }
}`;

  const opencode = `# ~/.config/opencode/config.json
{
  "mcp": {
    "firecrawl-self-hosted": {
      "type": "http",
      "url": "${url}",
      "headers": {
        "Authorization": "Bearer ${principal}",
        "CF-Access-Client-Id": "<service-token-id>",
        "CF-Access-Client-Secret": "<service-token-secret>"
      }
    }
  }
}`;

  const cursor = `# .cursor/mcp.json
{
  "mcpServers": {
    "firecrawl-self-hosted": {
      "url": "${url}",
      "headers": {
        "Authorization": "Bearer ${principal}",
        "CF-Access-Client-Id": "<service-token-id>",
        "CF-Access-Client-Secret": "<service-token-secret>"
      }
    }
  }
}`;

  return { claude, opencode, cursor };
}
