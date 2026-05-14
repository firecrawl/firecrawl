import { OpsMcpView } from './ops-mcp-view';

export const metadata = {
  title: 'MCP · Fire Enrich operations',
};

export const dynamic = 'force-dynamic';

export default function OpsMcpPage() {
  return <OpsMcpView />;
}
