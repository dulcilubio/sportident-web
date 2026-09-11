// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dulcilubio
// See NOTICE and LICENSE at the repository root.

/** Rousing a sleeping remote station, and the two beacon mode encodings. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SIStation } from '../src/station.js';
import { SimulatedTransport } from '../src/simulator.js';
import { CMD, MODE, O } from '../src/constants.js';
import { SINakError } from '../src/errors.js';

async function connected() {
  const sim = new SimulatedTransport({ latency: 0 });
  const station = new SIStation(sim, { retries: 0, timeout: 300 });
  await station.connect();
  return { sim, station };
}

/**
 * Model a sleeping station on the coupling stick: it refuses the probe wake()
 * sends, while the cabled station carries on answering everything else.
 */
function asleepUntil(station, until) {
  const real = station.sendCommand.bind(station);
  station.sendCommand = async (cmd, params, options) => {
    if (cmd === CMD.GET_TIME && Date.now() < until) throw new SINakError();
    return real(cmd, params, options);
  };
  return () => (station.sendCommand = real);
}

test('wake keeps trying until the station answers', async () => {
  const { station } = await connected();
  const wakesAt = Date.now() + 600;
  asleepUntil(station, wakesAt);

  const started = Date.now();
  const awake = await station.wake({ timeout: 5000, interval: 50 });

  assert.equal(awake, true, 'it eventually answered');
  assert.ok(Date.now() >= wakesAt, 'it kept trying past the first refusal');
  assert.ok(Date.now() - started < 3000, 'and stopped as soon as it did');

  await station.disconnect();
});

test('wake gives up at the budget rather than hanging', async () => {
  const { station } = await connected();
  asleepUntil(station, Date.now() + 60000); // never wakes

  const started = Date.now();
  const awake = await station.wake({ timeout: 700, interval: 50 });
  const spent = Date.now() - started;

  assert.equal(awake, false);
  assert.ok(spent >= 600, `used the budget, spent ${spent}ms`);
  assert.ok(spent < 2500, `did not overshoot it, spent ${spent}ms`);

  await station.disconnect();
});

test('wake does not block the event loop while it waits', async () => {
  const { station } = await connected();
  asleepUntil(station, Date.now() + 60000);

  // A timer set now must still fire while wake() is running.
  let ticked = 0;
  const ticker = setInterval(() => (ticked += 1), 50);
  await station.wake({ timeout: 600, interval: 50 });
  clearInterval(ticker);

  assert.ok(ticked >= 4, `the loop kept running, ${ticked} ticks`);

  await station.disconnect();
});

test('wake stops early when the signal is aborted', async () => {
  const { station } = await connected();
  asleepUntil(station, Date.now() + 60000);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);

  const started = Date.now();
  const awake = await station.wake({ timeout: 10000, interval: 50, signal: controller.signal });
  const spent = Date.now() - started;

  assert.equal(awake, false);
  assert.ok(spent < 2000, `gave up promptly, spent ${spent}ms`);

  await station.disconnect();
});

test('wake reports a broken link instead of retrying it', async () => {
  const { station } = await connected();
  station.sendCommand = async () => {
    throw new Error('the cable fell out');
  };

  await assert.rejects(() => station.wake({ timeout: 5000 }), /cable fell out/);

  await station.disconnect();
});

test('a station that answers at once costs no waiting', async () => {
  const { station } = await connected();
  const started = Date.now();
  assert.equal(await station.wake(), true);
  assert.ok(Date.now() - started < 500, 'returned straight away');
  await station.disconnect();
});

test('withRemote reports a station that never wakes, and goes back to direct', async () => {
  const { station } = await connected();
  await station.setDirect();
  asleepUntil(station, Date.now() + 60000);

  await assert.rejects(
    () => station.withRemote(() => station.readInfo(), { wake: 400 }),
    /did not answer within 400 ms/
  );
  assert.equal(station.target, 'direct', 'the session is back on the cable');

  await station.disconnect();
});

test('beacon modes fall back to the newer encoding when the old one is refused', async () => {
  const { station } = await connected();

  // A BSF9-style station: 0x12 is refused, 0x32 accepted.
  const written = [];
  const real = station.sendCommand.bind(station);
  station.sendCommand = async (cmd, params, options) => {
    if (cmd === CMD.SET_SYS_VAL && params?.[0] === O.MODE) {
      written.push(params[1]);
      if (params[1] === MODE.BC_CONTROL) throw new SINakError();
      return new Uint8Array();
    }
    return real(cmd, params, options);
  };

  const accepted = await station.setOperatingMode('beacon-control');

  assert.deepEqual(written, [MODE.BC_CONTROL, MODE.BC_CONTROL_NEW], 'old form tried first');
  assert.equal(accepted, MODE.BC_CONTROL_NEW, 'and the accepted byte comes back');

  await station.disconnect();
});

test('a station happy with the old beacon encoding is left alone', async () => {
  const { station } = await connected();

  const written = [];
  const real = station.sendCommand.bind(station);
  station.sendCommand = async (cmd, params, options) => {
    if (cmd === CMD.SET_SYS_VAL && params?.[0] === O.MODE) {
      written.push(params[1]);
      return new Uint8Array();
    }
    return real(cmd, params, options);
  };

  const accepted = await station.setOperatingMode('beacon-start');

  assert.deepEqual(written, [MODE.BC_START], 'no second attempt');
  assert.equal(accepted, MODE.BC_START);

  await station.disconnect();
});

test('both beacon encodings decode to the same name', () => {
  const pairs = [
    [MODE.BC_CONTROL, MODE.BC_CONTROL_NEW, 'BC control'],
    [MODE.BC_START, MODE.BC_START_NEW, 'BC start'],
    [MODE.BC_FINISH, MODE.BC_FINISH_NEW, 'BC finish'],
    [MODE.BC_READOUT, MODE.BC_READOUT_NEW, 'BC readout'],
  ];
  for (const [oldByte, newByte, name] of pairs) {
    assert.equal(newByte, oldByte + 0x20, 'the newer form sits 0x20 higher');
  }
});
