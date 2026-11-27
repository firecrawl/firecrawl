import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, chromium } from 'playwright';
import { createBrowserLifecycle } from './browser-lifecycle';

// A stand-in for a launched browser: `isConnected` and the `disconnected`
// listener are the only parts the lifecycle reads, and driving them directly
// lets a test place two callers inside one launch, which a real Chromium makes
// a matter of timing.
class FakeBrowser {
  connected = true;
  listeners: Array<() => void> = [];
  closed = false;

  isConnected() {
    return this.connected;
  }

  on(event: string, listener: () => void) {
    if (event === 'disconnected') this.listeners.push(listener);
    return this;
  }

  async close() {
    this.closed = true;
    this.connected = false;
    for (const listener of this.listeners) listener();
  }

  /** Simulates the process dying without going through `close()`. */
  crash() {
    this.connected = false;
    for (const listener of this.listeners) listener();
  }

  asBrowser(): Browser {
    return this as unknown as Browser;
  }
}

test('two callers during the first launch share that launch', async () => {
  const launched: FakeBrowser[] = [];
  let releaseLaunch: () => void = () => {};
  const launchGate = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });

  const lifecycle = createBrowserLifecycle(async () => {
    const browser = new FakeBrowser();
    launched.push(browser);
    await launchGate;
    return browser.asBrowser();
  });

  // Both callers arrive while the candidate is null and the launch is in flight.
  const first = lifecycle.ensureBrowser();
  const second = lifecycle.ensureBrowser();
  releaseLaunch();

  const [a, b] = await Promise.all([first, second]);

  assert.equal(launched.length, 1, 'only one browser should be launched');
  assert.equal(a, b, 'both callers must receive the same instance');
});

test('an idle browser is reused without launching again', async () => {
  const launched: FakeBrowser[] = [];
  const lifecycle = createBrowserLifecycle(async () => {
    const browser = new FakeBrowser();
    launched.push(browser);
    return browser.asBrowser();
  });

  const first = await lifecycle.ensureBrowser();
  const second = await lifecycle.ensureBrowser();

  assert.equal(launched.length, 1);
  assert.equal(first, second);
});

test('a browser whose process died is replaced on the next call', async () => {
  const launched: FakeBrowser[] = [];
  const lifecycle = createBrowserLifecycle(async () => {
    const browser = new FakeBrowser();
    launched.push(browser);
    return browser.asBrowser();
  });

  const first = await lifecycle.ensureBrowser();
  assert.equal(lifecycle.current(), first);

  // The crash leaves the object alive, so a `!browser` guard would have kept it.
  launched[0].crash();

  const second = await lifecycle.ensureBrowser();

  assert.equal(launched.length, 2, 'a dead browser must be replaced');
  assert.notEqual(first, second);
  assert.equal(lifecycle.current(), second);
});

test('a browser that died without emitting disconnected is still replaced', async () => {
  const launched: FakeBrowser[] = [];
  const lifecycle = createBrowserLifecycle(async () => {
    const browser = new FakeBrowser();
    launched.push(browser);
    return browser.asBrowser();
  });

  const first = await lifecycle.ensureBrowser();

  // The process can be gone before the event reaches us, and a crash under a
  // signal does not always deliver it at all. The slot still holds the handle,
  // so only `isConnected()` can tell that it is dead.
  launched[0].connected = false;

  const second = await lifecycle.ensureBrowser();

  assert.notEqual(second, first, 'a dead handle must not be reused');
  assert.equal(launched.length, 2);
});

test('the disconnected listener empties the slot before the next call', async () => {
  const launched: FakeBrowser[] = [];
  const lifecycle = createBrowserLifecycle(async () => {
    const browser = new FakeBrowser();
    launched.push(browser);
    return browser.asBrowser();
  });

  await lifecycle.ensureBrowser();
  assert.notEqual(lifecycle.current(), null);

  launched[0].crash();

  assert.equal(lifecycle.current(), null, 'the slot must clear when the browser goes away');
});

test('invalidate with a stale reference leaves the current browser alone', async () => {
  const launched: FakeBrowser[] = [];
  const lifecycle = createBrowserLifecycle(async () => {
    const browser = new FakeBrowser();
    launched.push(browser);
    return browser.asBrowser();
  });

  const first = await lifecycle.ensureBrowser();
  launched[0].crash();

  // A replacement lands while the caller still holds the old handle.
  const second = await lifecycle.ensureBrowser();
  assert.notEqual(first, second);

  lifecycle.invalidate(launched[0].asBrowser());
  assert.equal(lifecycle.current(), second, 'a stale handle must not evict the replacement');

  const third = await lifecycle.ensureBrowser();
  assert.equal(third, second, 'a stale invalidate must not force a relaunch');
  assert.equal(launched.length, 2);
});

test('invalidate on the live instance forces a relaunch', async () => {
  const launched: FakeBrowser[] = [];
  const lifecycle = createBrowserLifecycle(async () => {
    const browser = new FakeBrowser();
    launched.push(browser);
    return browser.asBrowser();
  });

  const first = await lifecycle.ensureBrowser();
  lifecycle.invalidate(first);
  assert.equal(lifecycle.current(), null);

  const second = await lifecycle.ensureBrowser();
  assert.notEqual(first, second);
  assert.equal(launched.length, 2);
});

test('shutdown closes the browser and empties the slot', async () => {
  const launched: FakeBrowser[] = [];
  const lifecycle = createBrowserLifecycle(async () => {
    const browser = new FakeBrowser();
    launched.push(browser);
    return browser.asBrowser();
  });

  await lifecycle.ensureBrowser();
  await lifecycle.shutdown();

  assert.equal(launched[0].closed, true, 'shutdown must close the browser');
  assert.equal(lifecycle.current(), null);
});

test('the service recovers from a real browser process exit', async () => {
  const lifecycle = createBrowserLifecycle();
  const first = await lifecycle.ensureBrowser();
  assert.equal(first.isConnected(), true);

  const context = await first.newContext();
  const page = await context.newPage();
  await page.setContent('<div id="content">Hello Firecrawl</div>');
  assert.equal(await page.textContent('#content'), 'Hello Firecrawl');
  await context.close();

  await first.close();

  const second = await lifecycle.ensureBrowser();
  assert.notEqual(second, first, 'a closed browser must be replaced');
  assert.equal(second.isConnected(), true);

  const recovered = await second.newContext();
  const recoveredPage = await recovered.newPage();
  await recoveredPage.setContent('<div id="content">Auto Recovered Successfully</div>');
  assert.equal(await recoveredPage.textContent('#content'), 'Auto Recovered Successfully');
  await recovered.close();

  await lifecycle.shutdown();
});

test('shutdown waits for an in-flight launch instead of leaking it', async () => {
  const launched: FakeBrowser[] = [];
  let releaseLaunch: () => void = () => {};
  const launchGate = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });

  const lifecycle = createBrowserLifecycle(async () => {
    const browser = new FakeBrowser();
    launched.push(browser);
    await launchGate;
    return browser.asBrowser();
  });

  // A relaunch is underway when shutdown arrives — the slot is still empty.
  const pending = lifecycle.ensureBrowser();
  const stopping = lifecycle.shutdown();
  // Let the in-flight launch finish; shutdown is already waiting on it.
  releaseLaunch();
  await Promise.all([pending, stopping]);

  assert.equal(launched.length, 1);
  assert.equal(
    launched[0].closed,
    true,
    'a browser launched during shutdown must still be closed',
  );
  assert.equal(lifecycle.current(), null, 'the slot must stay empty after shutdown');
});

test('shutdown is a no-op when nothing was launched', async () => {
  const lifecycle = createBrowserLifecycle();
  await lifecycle.shutdown();
  assert.equal(lifecycle.current(), null);
});
