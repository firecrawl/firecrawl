const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createBrowserManager } = require('./browser-manager.ts');

class FakeBrowser extends EventEmitter {
  connected = true;

  isConnected() {
    return this.connected;
  }

  disconnect() {
    this.connected = false;
    this.emit('disconnected');
  }
}

test('relaunches a browser after the current browser disconnects', async () => {
  const browsers = [new FakeBrowser(), new FakeBrowser()];
  let launches = 0;
  const manager = createBrowserManager(async () => browsers[launches++]);

  const first = await manager.getBrowser();
  first.disconnect();
  const second = await manager.getBrowser();

  assert.equal(second, browsers[1]);
  assert.equal(launches, 2);
});

test('shares one in-flight launch across concurrent requests', async () => {
  const browser = new FakeBrowser();
  let resolveLaunch;
  let launches = 0;
  const manager = createBrowserManager(
    () =>
      new Promise((resolve) => {
        launches++;
        resolveLaunch = resolve;
      }),
  );

  const first = manager.getBrowser();
  const second = manager.getBrowser();
  await Promise.resolve();
  resolveLaunch(browser);

  assert.equal(await first, browser);
  assert.equal(await second, browser);
  assert.equal(launches, 1);
});

test('a stale browser disconnect does not invalidate its replacement', async () => {
  const browsers = [new FakeBrowser(), new FakeBrowser()];
  let launches = 0;
  const manager = createBrowserManager(async () => browsers[launches++]);
  const first = await manager.getBrowser();
  first.disconnect();
  const second = await manager.getBrowser();

  first.emit('disconnected');

  assert.equal(await manager.getBrowser(), second);
  assert.equal(launches, 2);
});
