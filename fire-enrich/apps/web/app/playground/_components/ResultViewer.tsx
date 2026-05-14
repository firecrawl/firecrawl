'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { tomorrow } from 'react-syntax-highlighter/dist/esm/styles/prism';
import * as TabsPrimitive from '@radix-ui/react-tabs';

interface ResultViewerProps {
  result: unknown;
}

interface ExtractedShape {
  markdown: string | null;
  html: string | null;
}

function extract(result: unknown): ExtractedShape {
  if (!result || typeof result !== 'object') {
    return { markdown: null, html: null };
  }

  const r = result as Record<string, unknown>;

  if (typeof r.markdown === 'string' || typeof r.html === 'string') {
    return {
      markdown: typeof r.markdown === 'string' ? r.markdown : null,
      html: typeof r.html === 'string' ? r.html : null,
    };
  }

  if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
    const d = r.data as Record<string, unknown>;
    if (typeof d.markdown === 'string' || typeof d.html === 'string') {
      return {
        markdown: typeof d.markdown === 'string' ? d.markdown : null,
        html: typeof d.html === 'string' ? d.html : null,
      };
    }
  }

  if (Array.isArray(r.data)) {
    const docs = r.data as Array<Record<string, unknown>>;
    const md = docs
      .map((d) => (typeof d.markdown === 'string' ? d.markdown : null))
      .filter((m): m is string => !!m)
      .join('\n\n---\n\n');
    const html = docs
      .map((d) => (typeof d.html === 'string' ? d.html : null))
      .filter((h): h is string => !!h)
      .join('\n\n<hr/>\n\n');
    return {
      markdown: md || null,
      html: html || null,
    };
  }

  return { markdown: null, html: null };
}

const tabTriggerCls = [
  'inline-flex h-32 items-center gap-6 rounded-6 px-12',
  'text-label-medium font-medium text-black-alpha-56',
  'transition-[color,background-color] duration-150',
  'hover:text-accent-black',
  'data-[state=active]:bg-accent-white data-[state=active]:text-accent-black',
  'data-[state=active]:shadow-[0_0_0_1px_var(--border-muted),0_1px_2px_0_rgba(0,0,0,0.04)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-heat-40',
].join(' ');

const ratioFromBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

export function ResultViewer({ result }: ResultViewerProps) {
  const { markdown, html } = extract(result);
  const json = JSON.stringify(result, null, 2);

  return (
    <TabsPrimitive.Root defaultValue="markdown" className="flex flex-col gap-12">
      <TabsPrimitive.List className="inline-flex w-fit items-center gap-2 rounded-8 bg-black-alpha-4 p-3">
        <TabsPrimitive.Trigger value="markdown" className={tabTriggerCls}>
          Markdown
          {markdown && (
            <span className="font-mono text-mono-x-small text-black-alpha-48">
              {ratioFromBytes(new Blob([markdown]).size)}
            </span>
          )}
        </TabsPrimitive.Trigger>
        <TabsPrimitive.Trigger value="json" className={tabTriggerCls}>
          JSON
          <span className="font-mono text-mono-x-small text-black-alpha-48">
            {ratioFromBytes(new Blob([json]).size)}
          </span>
        </TabsPrimitive.Trigger>
        <TabsPrimitive.Trigger value="html" className={tabTriggerCls}>
          HTML
          {html && (
            <span className="font-mono text-mono-x-small text-black-alpha-48">
              {ratioFromBytes(new Blob([html]).size)}
            </span>
          )}
        </TabsPrimitive.Trigger>
      </TabsPrimitive.List>

      <TabsPrimitive.Content value="markdown" className="outline-none">
        <div className="max-h-[70vh] overflow-auto rounded-10 border border-border-muted bg-accent-white p-20">
          {markdown ? (
            <div className="prose prose-sm max-w-none prose-headings:tracking-tight prose-a:text-heat-100 prose-code:text-accent-black prose-code:bg-black-alpha-5 prose-code:px-4 prose-code:py-1 prose-code:rounded-4 prose-code:font-mono prose-code:before:content-none prose-code:after:content-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
            </div>
          ) : (
            <EmptyHint label="No markdown in this response." />
          )}
        </div>
      </TabsPrimitive.Content>

      <TabsPrimitive.Content value="json" className="outline-none">
        <div className="max-h-[70vh] overflow-auto rounded-10 border border-border-muted bg-[#0f1014]">
          <SyntaxHighlighter
            language="json"
            style={tomorrow}
            customStyle={{
              margin: 0,
              padding: '20px',
              fontSize: '12px',
              lineHeight: '18px',
              background: 'transparent',
              fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
            }}
            wrapLongLines
          >
            {json}
          </SyntaxHighlighter>
        </div>
      </TabsPrimitive.Content>

      <TabsPrimitive.Content value="html" className="outline-none">
        <div className="max-h-[70vh] overflow-auto rounded-10 border border-border-muted bg-accent-white">
          {html ? (
            <details className="p-20">
              <summary className="cursor-pointer text-body-small font-medium text-accent-black">
                Show HTML source{' '}
                <span className="font-mono text-mono-small text-black-alpha-56">
                  ({html.length.toLocaleString()} chars)
                </span>
              </summary>
              <pre className="mt-16 whitespace-pre-wrap break-all rounded-8 bg-black-alpha-4 p-16 font-mono text-mono-x-small text-accent-black">
                {html}
              </pre>
            </details>
          ) : (
            <div className="p-20">
              <EmptyHint label="No HTML in this response." />
            </div>
          )}
        </div>
      </TabsPrimitive.Content>
    </TabsPrimitive.Root>
  );
}

function EmptyHint({ label }: { label: string }) {
  return (
    <p className="text-body-small text-black-alpha-56">{label}</p>
  );
}
