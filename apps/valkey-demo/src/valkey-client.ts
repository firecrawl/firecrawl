import { GlideClient } from '@valkey/valkey-glide';
import { config } from './config';

let client: GlideClient | null = null;

export async function getValkeyClient(): Promise<GlideClient> {
  if (!client) {
    // Parse URL to extract host, port, and password
    // Supports: redis://localhost:6379, redis://:password@localhost:6379
    const url = config.valkey.url;
    let host = 'localhost';
    let port = 6379;
    let password: string | undefined;

    try {
      // Replace redis:// with http:// for URL parsing
      const parsed = new URL(url.replace(/^rediss?:\/\//, 'http://'));
      host = parsed.hostname || 'localhost';
      port = parseInt(parsed.port, 10) || 6379;
      
      // Password can be in the format redis://:password@host or redis://user:password@host
      if (parsed.password) {
        password = decodeURIComponent(parsed.password);
      }
    } catch (e) {
      console.warn('[Valkey GLIDE] Could not parse URL, using defaults');
    }

    const clientConfig: Parameters<typeof GlideClient.createClient>[0] = {
      addresses: [{ host, port }],
      requestTimeout: 5000,
      clientName: 'valkey-demo',
    };

    // Add credentials if password is provided
    if (password) {
      clientConfig.credentials = { password };
    }

    client = await GlideClient.createClient(clientConfig);
    console.log(`[Valkey GLIDE] Connected to ${host}:${port}${password ? ' (authenticated)' : ''}`);
  }
  return client;
}

export async function closeValkeyClient(): Promise<void> {
  if (client) {
    client.close();
    client = null;
    console.log('[Valkey GLIDE] Connection closed');
  }
}
