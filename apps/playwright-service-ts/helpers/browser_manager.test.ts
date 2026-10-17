import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import {
  isBrowserConnected,
  createBrowserManager,
  isTargetClosedError,
} from './browser_manager';

class MockBrowser extends EventEmitter {
  private _connected: boolean;

  constructor(connected: boolean = true) {
    super();
    this._connected = connected;
  }

  isConnected(): boolean {
    return this._connected;
  }

  simulateDisconnect() {
    this._connected = false;
    this.emit('disconnected');
  }
}

describe('BrowserManager', () => {
  it('correctly detects browser connection state', () => {
    assert.strictEqual(isBrowserConnected(null), false);
    assert.strictEqual(isBrowserConnected(undefined), false);

    const activeBrowser = new MockBrowser(true);
    assert.strictEqual(isBrowserConnected(activeBrowser as any), true);

    const deadBrowser = new MockBrowser(false);
    assert.strictEqual(isBrowserConnected(deadBrowser as any), false);
  });

  it('identifies TargetClosedError by message or name', () => {
    assert.strictEqual(
      isTargetClosedError(new Error('Target page, context or browser has been closed')),
      true,
    );
    const err = new Error('random error');
    err.name = 'TargetClosedError';
    assert.strictEqual(isTargetClosedError(err), true);

    assert.strictEqual(isTargetClosedError(new Error('timeout')), false);
    assert.strictEqual(isTargetClosedError(null), false);
  });

  it('initializes browser and re-initializes on disconnect', async () => {
    let launchCount = 0;
    const browsers: MockBrowser[] = [];

    const manager = createBrowserManager({
      launcher: async () => {
        launchCount++;
        const b = new MockBrowser(true);
        browsers.push(b);
        return b as any;
      },
    });

    assert.strictEqual(manager.isReady(), false);

    // First initialization
    const b1 = await manager.ensureBrowser();
    assert.strictEqual(launchCount, 1);
    assert.strictEqual(manager.isReady(), true);

    // Subsequent call reuses existing instance
    const b1Again = await manager.ensureBrowser();
    assert.strictEqual(b1Again, b1);
    assert.strictEqual(launchCount, 1);

    // Simulate browser death / disconnect
    browsers[0].simulateDisconnect();
    assert.strictEqual(manager.isReady(), false);

    // Next call should recover and launch a new browser
    const b2 = await manager.ensureBrowser();
    assert.strictEqual(launchCount, 2);
    assert.notStrictEqual(b2, b1);
    assert.strictEqual(manager.isReady(), true);
  });

  it('handles concurrency when multiple requests attempt initialization simultaneously', async () => {
    let launchCount = 0;
    const manager = createBrowserManager({
      launcher: async () => {
        launchCount++;
        await new Promise((r) => setTimeout(r, 50));
        return new MockBrowser(true) as any;
      },
    });

    const [b1, b2, b3] = await Promise.all([
      manager.ensureBrowser(),
      manager.ensureBrowser(),
      manager.ensureBrowser(),
    ]);

    assert.strictEqual(launchCount, 1);
    assert.strictEqual(b1, b2);
    assert.strictEqual(b2, b3);
  });

  it('resets browser reference when handling TargetClosedError', async () => {
    let launchCount = 0;
    const manager = createBrowserManager({
      launcher: async () => {
        launchCount++;
        return new MockBrowser(true) as any;
      },
    });

    await manager.ensureBrowser();
    assert.strictEqual(manager.isReady(), true);

    const handled = manager.handleError(
      new Error('Target page, context or browser has been closed'),
    );
    assert.strictEqual(handled, true);
    assert.strictEqual(manager.isReady(), false);

    await manager.ensureBrowser();
    assert.strictEqual(launchCount, 2);
  });
});
