// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dulcilubio
// See NOTICE and LICENSE at the repository root.

/** Operating modes, and switching between the cabled station and a remote one. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SIStation } from '../src/station.js';
import { SimulatedTransport } from '../src/simulator.js';
import { CMD, MODE, MODE_BY_NAME, O, P_MS_DIRECT, P_MS_INDIRECT } from '../src/constants.js';

async function connected(options = {}) {
  const sim = new SimulatedTransport({ latency: 0, ...options });
  const station = new SIStation(sim, { retries: 0, timeout: 1000 });
  await station.connect();
  return { sim, station };
}

test('modes can be set by name or by constant', async () => {
  const { station } = await connected();

  await station.setOperatingMode('start');
  assert.equal(station.mode, MODE.START);
  assert.equal(station.modeName, 'Start');

  await station.setOperatingMode(MODE.CHECK);
  assert.equal(station.mode, MODE.CHECK);
  assert.equal(station.modeName, 'Check');

  // Names are forgiving about case and stray spaces.
  await station.setOperatingMode('  ReadOut ');
  assert.equal(station.mode, MODE.READOUT);

  await station.disconnect();
});

test('every shorthand sets the mode it says', async () => {
  const { station } = await connected();

  const shorthands = [
    ['setStartMode', MODE.START],
    ['setCheckMode', MODE.CHECK],
    ['setFinishMode', MODE.FINISH],
    ['setReadoutMode', MODE.READOUT],
    ['setClearMode', MODE.CLEAR],
    ['setControlMode', MODE.CONTROL],
  ];

  for (const [method, expected] of shorthands) {
    await station[method]();
    assert.equal(station.mode, expected, `${method}() should give 0x${expected.toString(16)}`);
  }

  await station.disconnect();
});

test('every name in MODE_BY_NAME is actually settable', async () => {
  const { station } = await connected();
  for (const [name, value] of Object.entries(MODE_BY_NAME)) {
    await station.setOperatingMode(name);
    assert.equal(station.mode, value, `"${name}" should give 0x${value.toString(16)}`);
  }
  await station.disconnect();
});

test('a nonsense mode is refused before anything is written', async () => {
  const { sim, station } = await connected();
  await station.setOperatingMode('start');

  const sent = [];
  const realWrite = sim.write.bind(sim);
  sim.write = (bytes) => {
    sent.push(Array.from(bytes));
    return realWrite(bytes);
  };

  await assert.rejects(() => station.setOperatingMode('sprint'), /Unknown mode "sprint"/);
  await assert.rejects(() => station.setOperatingMode(0x99), /Cannot set mode 0x99/);

  assert.equal(sent.length, 0, 'nothing went down the wire');
  assert.equal(station.mode, MODE.START, 'the station is untouched');

  await station.disconnect();
});

test('direct and remote flip the target and the SET_MS argument', async () => {
  const { sim, station } = await connected();
  assert.equal(station.target, 'direct');

  const args = [];
  const realWrite = sim.write.bind(sim);
  sim.write = (bytes) => {
    const b = Array.from(bytes);
    const i = b.indexOf(CMD.SET_MS);
    if (i !== -1) args.push(b[i + 2]);
    return realWrite(bytes);
  };

  await station.setRemote();
  assert.equal(station.target, 'remote');
  assert.equal(station.direct, false);
  assert.equal(args.at(-1), P_MS_INDIRECT, 'the relay byte went out');

  await station.setDirect();
  assert.equal(station.target, 'direct');
  assert.equal(args.at(-1), P_MS_DIRECT);

  await station.setTarget('remote');
  assert.equal(station.target, 'remote');
  await station.setTarget('direct');
  assert.equal(station.target, 'direct');

  await assert.rejects(() => station.setTarget('sideways'), /Unknown target/);

  await station.disconnect();
});

test('withRemote goes back to direct even when the body throws', async () => {
  const { station } = await connected();

  await assert.rejects(
    () => withRemoteThatThrows(station),
    /card jammed/,
    'the original error is what the caller sees'
  );
  assert.equal(station.target, 'direct', 'and the session is back on the cable');

  await station.disconnect();
});

function withRemoteThatThrows(station) {
  return station.withRemote(async () => {
    assert.equal(station.target, 'remote', 'the body runs against the remote station');
    throw new Error('card jammed');
  });
}

test('withRemote returns the value and restores direct on success', async () => {
  const { station } = await connected();

  const seen = await station.withRemote(async (s) => {
    assert.equal(s.target, 'remote');
    return 'read it';
  });

  assert.equal(seen, 'read it');
  assert.equal(station.target, 'direct');

  await station.disconnect();
});

test('a failed restore is announced rather than swallowed', async () => {
  const { station } = await connected();

  const errors = [];
  station.addEventListener('error', (e) => errors.push(e.detail.error));

  // Let the switch to remote happen, then break the way back.
  const realSetDirect = station.setDirect.bind(station);
  let broken = true;
  station.setDirect = async () => {
    if (broken) throw new Error('the bridge stopped answering');
    return realSetDirect();
  };

  await assert.rejects(
    () => station.withRemote(async () => 'fine'),
    /the bridge stopped answering/,
    'the restore failure surfaces when nothing else went wrong'
  );
  assert.equal(errors.length, 1, 'and it was dispatched as an error event');

  broken = false;
  await station.setDirect();
  await station.disconnect();
});

test('remote mode is refused when the cabled station cannot relay', async () => {
  // Legacy protocol: the bridge will not forward anything.
  const { station } = await connected({ mode: MODE.READOUT });
  station.protoConfig = { ...station.protoConfig, extendedProtocol: false };

  await assert.rejects(() => station.setRemote(), /extended protocol/);
  assert.equal(station.target, 'direct', 'so it stays on the cable');

  await station.disconnect();
});

test('switching target drops sysval cached from the other station', async () => {
  const { station } = await connected();
  await station.refreshSysval();
  assert.notEqual(station.sysval, null);

  await station.setRemote();
  assert.equal(station.sysval, null, 'stale data would describe the wrong station');

  await station.disconnect();
});
