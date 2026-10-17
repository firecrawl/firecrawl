import assert from 'node:assert';
import { chromium, Browser } from 'playwright';

async function runTests() {
  console.log('=== Playwright Browser Resilience and Lifecycle Test ===');

  // Test Case 1: Reproduce Issue #4993 defect (Old Pattern)
  console.log('Scenario 1: Demonstrating the unhandled disconnect failure without reset/isConnected guard...');
  {
    let danglingBrowser: Browser | null = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    assert.strictEqual(danglingBrowser.isConnected(), true);

    // Simulate browser process crash / kill
    await danglingBrowser.close();
    await new Promise((r) => setTimeout(r, 50));

    // Notice: under the old pattern `if (!browser)`, danglingBrowser is still an object (not null)
    const oldGuardRelaunched = !danglingBrowser;
    assert.strictEqual(oldGuardRelaunched, false, 'Old `if (!browser)` guard fails to re-launch because reference is dangling');

    // And attempting to create a newContext throws TargetClosedError
    let thrownError: any = null;
    try {
      await danglingBrowser.newContext();
    } catch (err) {
      thrownError = err;
    }
    assert.ok(thrownError, 'Expected TargetClosedError on disconnected browser');
    assert.ok(
      thrownError.name === 'TargetClosedError' || String(thrownError).includes('closed'),
      'Error should indicate target/browser is closed',
    );
    console.log('  -> Confirmed: dangling browser causes permanent 500/503 errors under old pattern.');
  }

  // Test Case 2: Verify the new resilient ensureBrowser pattern (New Pattern)
  console.log('Scenario 2: Testing ensureBrowser with disconnected handler and isConnected validation...');
  {
    let browser: Browser | null = null;
    let browserInitPromise: Promise<Browser> | null = null;
    let disconnectedEventsFired = 0;

    const ensureBrowser = async (): Promise<Browser> => {
      if (browser && browser.isConnected()) {
        return browser;
      }

      if (!browserInitPromise) {
        browserInitPromise = (async () => {
          try {
            if (browser) {
              try {
                await browser.close().catch(() => {});
              } catch (_) {}
              browser = null;
            }

            const newBrowser = await chromium.launch({
              headless: true,
              args: ['--no-sandbox', '--disable-setuid-sandbox'],
            });

            newBrowser.on('disconnected', () => {
              disconnectedEventsFired++;
              if (browser === newBrowser) {
                browser = null;
              }
            });

            browser = newBrowser;
            return newBrowser;
          } finally {
            browserInitPromise = null;
          }
        })();
      }

      return browserInitPromise;
    };

    // 1. Initial creation
    const b1 = await ensureBrowser();
    assert.ok(b1.isConnected(), 'Initial browser should be connected');

    // 2. Concurrent access returns the exact same instance
    const [b1_copy1, b1_copy2] = await Promise.all([ensureBrowser(), ensureBrowser()]);
    assert.strictEqual(b1_copy1, b1, 'Concurrent call 1 should reuse the same instance');
    assert.strictEqual(b1_copy2, b1, 'Concurrent call 2 should reuse the same instance');

    // 3. Functional scrape verification on b1
    const ctx1 = await b1.newContext();
    const page1 = await ctx1.newPage();
    await page1.setContent('<div id="content">Hello Firecrawl</div>');
    const text1 = await page1.textContent('#content');
    assert.strictEqual(text1, 'Hello Firecrawl');
    await ctx1.close();

    // 4. Simulate browser process death (kill/close)
    await b1.close();
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(disconnectedEventsFired, 1, 'Disconnected event listener must fire');
    assert.strictEqual(browser, null, 'Active browser variable must reset to null');

    // 5. Next request automatically recovers by launching a fresh browser
    const b2 = await ensureBrowser();
    assert.ok(b2, 'Fresh browser should be initialized');
    assert.strictEqual(b2.isConnected(), true, 'Fresh browser must be connected');
    assert.notStrictEqual(b2, b1, 'Recovered browser must be a new instance');

    // 6. Verify that the recovered browser works flawlessly
    const ctx2 = await b2.newContext();
    const page2 = await ctx2.newPage();
    await page2.setContent('<div id="content">Auto Recovered Successfully</div>');
    const text2 = await page2.textContent('#content');
    assert.strictEqual(text2, 'Auto Recovered Successfully');
    await ctx2.close();

    await b2.close();
    console.log('  -> Confirmed: Service automatically recovers immediately on browser process death!');
  }

  console.log('🎉 All browser resilience tests passed!');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
