import assert from 'node:assert/strict';
import { test } from 'node:test';
import { monitorStation } from '../config/heartbeat.js';
import { CMD } from '../src/constants.js';
import { SIStation } from '../src/station.js';
import { SimulatedTransport } from '../src/simulator.js';

function setup(t) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const station = Object.assign(new EventTarget(), { isOpen: true, busy: false, isCommunicating: false });
  let idle = true;
  let fail = false;
  const calls = [];
  const states = [];
  station.sendCommand = async (...args) => {
    calls.push(args);
    if (fail) throw new Error('Timeout');
  };
  const monitor = monitorStation(station, { isIdle: () => idle, onStatus: state => states.push(state) });
  t.after(() => monitor.stop());
  return { station, monitor, calls, states, idle: v => { idle = v; }, fail: v => { fail = v; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('heartbeat waits 60 seconds and probes without wake or retry', async t => {
  const { calls } = setup(t);
  t.mock.timers.tick(59999);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(calls, [[CMD.GET_TIME, [], { retries: 0, timeout: 2000, wakeup: false }]]);
});

test('heartbeat skips configuration, queued commands, card transfers, and a closed port', async t => {
  const r = setup(t);
  r.idle(false);
  await r.monitor.check();
  r.idle(true);
  r.station.busy = true;
  await r.monitor.check();
  r.station.busy = false;
  r.station.isCommunicating = true;
  await r.monitor.check();
  r.station.isCommunicating = false;
  r.station.isOpen = false;
  await r.monitor.check();
  assert.equal(r.calls.length, 0);
});

test('heartbeat reports loss and recovery and stops after disconnect', async t => {
  const r = setup(t);
  await r.monitor.check();
  const previous = r.states.at(-1).lastResponse;
  r.fail(true);
  await r.monitor.check();
  assert.equal(r.states.at(-1).healthy, false);
  assert.equal(r.states.at(-1).lastResponse, previous);
  r.fail(false);
  await r.monitor.check();
  assert.equal(r.states.at(-1).healthy, true);
  r.station.dispatchEvent(new Event('close'));
  const count = r.calls.length;
  t.mock.timers.tick(120000);
  await settle();
  assert.equal(r.calls.length, count);
});

test('stopped target ignores late replies and concurrent checks do not overlap', async t => {
  const r = setup(t);
  let finish;
  r.station.sendCommand = () => new Promise(resolve => { finish = resolve; });
  const pending = r.monitor.check();
  await r.monitor.check();
  r.monitor.stop();
  finish();
  await pending;
  assert.equal(r.states.length, 0);
});

test('queued commands report activity, including cleanup after a failed transport write', async t => {
  const transport = new SimulatedTransport({ latency: 0 });
  const station = new SIStation(transport, { retries: 0, timeout: 100 });
  await station.connect();
  t.after(() => station.disconnect());
  const pending = station.getTime();
  assert.equal(station.isCommunicating, true);
  await pending;
  assert.equal(station.isCommunicating, false);
  transport.write = async () => { throw new Error('Adapter disconnected'); };
  await assert.rejects(station.getTime(), /Adapter disconnected/);
  assert.equal(station.isCommunicating, false);
});
