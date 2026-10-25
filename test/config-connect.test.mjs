import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { requestStation } from '../src/connect.js';

const app = await readFile(new URL('../config/app.js', import.meta.url), 'utf8');
const connectionHandlers = app.slice(
  app.indexOf('async function connectWith('),
  app.indexOf("on('simulate',"),
);

test('config releases a partially connected station when loading details fails', async () => {
  let disconnects = 0;
  let connects = 0;
  const errors = [];
  const next = {
    addEventListener() {},
    async connect() { connects++; },
    async disconnect() { disconnects++; },
  };
  const context = {
    station: null,
    ui: { connect: {}, connectUsb: {}, simulate: {} },
    setStatus() {},
    startMonitoring() {},
    monitor: null,
    setControlsEnabled() {},
    fail: (error) => errors.push(error.message),
    refreshFacts: async () => { throw new Error('Details failed'); },
  };
  runInNewContext(app.slice(
    app.indexOf('async function attach(next)'),
    app.indexOf('// -------------------------------------------------------------- station panel'),
  ), context);
  const pending = context.attach(next);
  await context.attach(next);
  await pending;
  assert.equal(connects, 1, 'overlapping attempts cannot replace the station');
  assert.equal(disconnects, 1);
  assert.equal(context.station, null);
  assert.deepEqual(errors, ['Details failed']);
  await context.attach(next);
  assert.equal(connects, 2, 'a fresh attempt is allowed after cleanup');
});

test('config Connect exposes RS232 adapters and keeps WebUSB separate', async (t) => {
  const serialRequests = [];
  const usbRequests = [];
  const attached = [];
  const source = {};
  let cancelled = false;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      serial: {
        async requestPort(options) {
          serialRequests.push(options);
          if (cancelled) throw new DOMException('Cancelled', 'NotFoundError');
          return source;
        },
      },
      usb: {
        async requestDevice(options) {
          usbRequests.push(options);
          return source;
        },
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  });
  const handlers = {};
  const support = { webSerial: true };
  runInNewContext(connectionHandlers, {
    support,
    requestStation,
    on: (id, event, handler) => { handlers[id] = handler; },
    toTransport: (value) => value,
    SIReadout: class { constructor(value) { this.source = value; } },
    attach: async (station) => { attached.push(station.source); },
    fail: (error) => { throw error; },
  });

  await handlers.connect();
  assert.deepEqual(serialRequests, [{}], 'no USB ID filter hides adapters');
  assert.deepEqual(attached, [source]);
  assert.equal(usbRequests.length, 0);

  cancelled = true;
  await handlers.connect();
  assert.equal(usbRequests.length, 0, 'cancellation does not open a USB picker');

  await handlers.connectUsb();
  assert.ok(usbRequests[0].filters.length, 'WebUSB still filters supported devices');

  support.webSerial = false;
  await handlers.connect();
  assert.equal(usbRequests.length, 2, 'USB remains available without Web Serial');
});
