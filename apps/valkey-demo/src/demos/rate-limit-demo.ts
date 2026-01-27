import { RateLimiter } from '../services/rate-limiter';
import { getValkeyClient, closeValkeyClient } from '../valkey-client';

/**
 * Demo: Rate limiting with Valkey GLIDE
 * Shows sliding window rate limiting for API protection
 */
export async function runRateLimitDemo(): Promise<void> {
  console.log('\n=== Rate Limiting Demo with Valkey GLIDE ===\n');

  // Create a rate limiter: 5 requests per 10 seconds for demo
  const rateLimiter = new RateLimiter(5, 10000);
  const userId = 'demo-user-123';

  try {
    const client = await getValkeyClient();
    await client.ping();
    console.log('[Demo] Connected to Valkey via GLIDE\n');

    // Reset any existing limits for clean demo
    await rateLimiter.resetLimit(userId);
    console.log(`[Demo] Rate limit config: 5 requests per 10 seconds\n`);

    // Simulate rapid requests
    console.log('[Demo] Simulating 8 rapid requests...\n');
    
    for (let i = 1; i <= 8; i++) {
      const result = await rateLimiter.checkLimit(userId);
      
      if (result.allowed) {
        console.log(`[Demo] Request ${i}: ✅ ALLOWED (${result.remaining} remaining)`);
      } else {
        const resetIn = Math.ceil((result.resetAt - Date.now()) / 1000);
        console.log(`[Demo] Request ${i}: ❌ BLOCKED (resets in ${resetIn}s)`);
      }
      
      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Wait for window to partially reset
    console.log('\n[Demo] Waiting 5 seconds...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check remaining
    const remaining = await rateLimiter.getRemainingRequests(userId);
    console.log(`[Demo] After waiting: ${remaining} requests available`);

    // Try a few more requests
    console.log('\n[Demo] Trying 3 more requests...\n');
    for (let i = 1; i <= 3; i++) {
      const result = await rateLimiter.checkLimit(userId);
      console.log(`[Demo] Request ${i}: ${result.allowed ? '✅ ALLOWED' : '❌ BLOCKED'} (${result.remaining} remaining)`);
    }

  } finally {
    await closeValkeyClient();
  }
}

if (require.main === module) {
  runRateLimitDemo().catch(console.error);
}
