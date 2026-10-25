// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dulcilubio
// See NOTICE and LICENSE at the repository root.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SIReadout } from '../src/readout.js';
import { SimulatedTransport } from '../src/simulator.js';
import { ACK, CARD, CMD, MODE, O } from '../src/constants.js';
import { concat, toBytes } from '../src/bytes.js';

async function setup(t, options = {}) {
  const sim = new SimulatedTransport({ latency: 0, mode: MODE.READOUT });
  sim.sysval[O.PROTO] = 3; // extended protocol, autosend
  const station = new SIReadout(sim, { timeout: 100, retries: 0, ...options });
  const cards = [], errors = [], inserted = [], writes = [];
  station.addEventListener('card', e => cards.push(e.detail));
  station.addEventListener('cardError', e => errors.push(e.detail.error));
  station.addEventListener('cardInserted', e => inserted.push(e.detail));
  const write = sim.write.bind(sim);
  sim.write = bytes => { writes.push([...bytes]); return write(bytes); };
  await station.connect();
  assert.equal(writes.some(bytes => bytes.includes(CMD.GET_SI9)), false, 'no probing during autosend');
  writes.length = 0;
  t.after(() => station.disconnect());
  return { sim, station, cards, errors, inserted, writes };
}

// Simulator supplies valid compact dumps; label their blocks with the physical
// block numbers that autosend uses, rather than the simulator's read indices.
function fixture(type, number) {
  const sim = new SimulatedTransport();
  sim.send = () => {}; // no insertion event: the reported failure
  const count = type === 'SI10' ? 100 : 3;
  sim.insertCard(number, { punches: Array.from({ length: count }, (_, i) => ({
    code: 31 + i, time: new Date(2026, 8, 25, 10, i, 0),
  })) });
  const blocks = type === 'SI5' ? [0] : type === 'SI6' ? [0, 6, 7]
    : type === 'SI10' ? [0, 4, 5, 6, 7] : [0, 1];
  const cmd = type === 'SI5' ? CMD.GET_SI5 : type === 'SI6' ? CMD.GET_SI6 : CMD.GET_SI9;
  return blocks.map((block, i) => ({ cmd, station: 31,
    data: type === 'SI5' ? sim.card.dump : concat([block], sim.card.dump.slice(i * 128, (i + 1) * 128)),
  }));
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
function send(sim, frames) { for (const frame of frames) sim.send(frame.cmd, frame.data); }

for (const [type, number] of [['SI5', 12345], ['SI6', 600001], ['SI8', 2125966],
  ['SI9', 1000001], ['pCard', 4000001], ['SI10', 8549150]]) {
  test(`autosend ${type} produces card and ACK without a detection frame or read request`, async t => {
    const r = await setup(t);
    send(r.sim, fixture(type, number));
    await settle();
    assert.equal(r.cards.length, 1);
    assert.equal(r.cards[0].cardNumber, number);
    assert.equal(r.cards[0].cardType, type);
    assert.deepEqual(r.cards[0].punches.map(p => p.code),
      Array.from({ length: type === 'SI10' ? 100 : 3 }, (_, i) => 31 + i));
    assert.equal(r.cards[0].raw.length, fixture(type, number).length * 128);
    assert.deepEqual(r.writes, [[ACK]], 'only ACK is sent');
    assert.equal(r.errors.length, 0);
    assert.equal(r.inserted.length, 1);
  });
}

test('matching manual read replies still resolve requests and never emit autosend cards', async t => {
  const r = await setup(t, { autoRead: false });
  r.sim.insertCard(2125966);
  await settle();
  const card = await r.station.readCard();
  assert.equal(card.cardNumber, 2125966);
  assert.equal(r.cards.length, 0);
  assert.equal(r.errors.length, 0);
  assert.equal(r.inserted.length, 1, 'no extra insertion from solicited blocks');
});

test('autosend blocks during an unrelated request do not consume its response', async t => {
  const r = await setup(t);
  r.sim.latency = 10;
  const time = r.station.getTime();
  await Promise.resolve();
  send(r.sim, fixture('SI8', 2125966));
  assert.ok(await time instanceof Date);
  await settle();
  assert.equal(r.cards.length, 1);
});

test('an autosend detection does not trigger competing read commands', async t => {
  const r = await setup(t);
  r.sim.send(CMD.SI9_DET, concat([0xee], toBytes(2125966, 3)));
  send(r.sim, fixture('SI8', 2125966));
  await settle();
  assert.deepEqual(r.writes, [[ACK]]);
  assert.equal(r.cards.length, 1);
  assert.equal(r.inserted.length, 1, 'the announcement and block zero describe the same insertion');
});

for (const options of [{ autoRead: false }, { autoAck: false }]) {
  test(`autosend respects ${JSON.stringify(options)}`, async t => {
    const r = await setup(t, options);
    send(r.sim, fixture('SI8', 2125966));
    await settle();
    assert.equal(r.cards.length, options.autoRead === false ? 0 : 1);
    assert.equal(r.station.cardNumber, 2125966);
    assert.equal(r.inserted.length, 1);
    assert.equal(r.writes.length, 0);
  });
}

test('missing blocks time out without emitting or acknowledging a partial card', async t => {
  const r = await setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  r.station.handleUnsolicited(fixture('SI8', 2125966)[0]);
  assert.equal(r.station.isCommunicating, true, 'heartbeat must wait for the remaining card blocks');
  t.mock.timers.tick(5000);
  assert.equal(r.station.isCommunicating, false, 'timed-out transfers release the idle state');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].name, 'SITimeoutError');
  assert.equal(r.cards.length, 0);
  assert.equal(r.writes.length, 0);
});

test('removal discards old blocks, and a new card starts a fresh transfer', async t => {
  const r = await setup(t);
  const frames = fixture('SI8', 2125966);
  send(r.sim, frames.slice(0, 1));
  r.sim.removeCard();
  send(r.sim, frames.slice(1));
  await settle();
  assert.equal(r.cards.length, 0);
  assert.equal(r.errors.length, 1);
  send(r.sim, fixture('SI8', 2125967));
  await settle();
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].cardNumber, 2125967);
});

test('duplicate and out-of-order continuation blocks do not duplicate or reorder punches', async t => {
  const r = await setup(t);
  const f = fixture('SI10', 8549150);
  send(r.sim, [f[0], f[3], f[3], f[2], f[1], f[4]]);
  await settle();
  assert.equal(r.cards.length, 1);
  assert.deepEqual(r.cards[0].punches.map(p => p.code), Array.from({ length: 100 }, (_, i) => 31 + i));
});

test('short blocks and unsupported SI6 punch counts fail without ACK', async t => {
  const r = await setup(t);
  r.sim.send(CMD.GET_SI9, [0, 1]);
  const [f] = fixture('SI6', 600001);
  f.data[1 + CARD.SI6.RC] = 192;
  send(r.sim, [f]);
  await settle();
  assert.equal(r.errors.length, 2);
  assert.equal(r.cards.length, 0);
  assert.equal(r.writes.length, 0);
});

test('closing the transport clears an incomplete transfer and its timer', async t => {
  const r = await setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  r.station.handleUnsolicited(fixture('SI8', 2125966)[0]);
  await r.station.disconnect();
  t.mock.timers.tick(5000);
  assert.equal(r.errors.length, 0);
  assert.equal(r.cards.length, 0);
});
