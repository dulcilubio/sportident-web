// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dulcilubio
// See NOTICE and LICENSE at the repository root.

/** Finding a card that is already in the station, and the punch-handling bits. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SIReadout } from '../src/readout.js';
import { SimulatedTransport } from '../src/simulator.js';
import { MODE } from '../src/constants.js';

function readout(options = {}) {
  const sim = new SimulatedTransport({ latency: 0, mode: MODE.READOUT });
  const station = new SIReadout(sim, { retries: 0, timeout: 800, ...options });
  return { sim, station };
}

test('an empty station reports no card rather than failing', async () => {
  const { station } = await (async () => {
    const r = readout();
    await r.station.connect();
    return r;
  })();

  assert.equal(await station.detectCard(), null);
  await station.disconnect();
});

test('a card already in the station is found', async () => {
  const { sim, station } = readout({ autoRead: false });
  await station.connect();

  sim.insertCard(8549150);
  const found = await station.detectCard({ read: false });

  assert.deepEqual(found, { cardNumber: 8549150, cardType: 'SI10' });
  assert.equal(station.cardNumber, 8549150, 'and it becomes the current card');

  await station.disconnect();
});

test('connecting to a station that already holds a card reads it', async () => {
  const { sim, station } = readout();
  sim.insertCard(8549150); // in before anyone is listening

  const cards = [];
  station.addEventListener('card', (e) => cards.push(e.detail));
  await station.connect();
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(cards.length, 1, 'the card was read without an insertion event');
  assert.equal(cards[0].cardNumber, 8549150);

  await station.disconnect();
});

test('detectOnConnect can be turned off', async () => {
  const { sim, station } = readout({ detectOnConnect: false });
  sim.insertCard(8549150);

  const cards = [];
  station.addEventListener('card', (e) => cards.push(e.detail));
  await station.connect();
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(cards.length, 0, 'nothing was probed for');
  await station.disconnect();
});

test('a card inserted later still arrives the usual way', async () => {
  const { sim, station } = readout();
  await station.connect();

  const cards = [];
  station.addEventListener('card', (e) => cards.push(e.detail));
  sim.insertCard(8549150);
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(cards.length, 1, 'the announcement path is untouched');
  await station.disconnect();
});

test('live punches and card readout are mutually exclusive', async () => {
  const { station } = readout();
  await station.connect();

  await station.setAutoSend(true);
  assert.equal(station.protoConfig.autoSend, true, 'punches stream');
  assert.equal(station.protoConfig.handshake, false, 'so readout handshake is off');

  await station.setAutoSend(false);
  assert.equal(station.protoConfig.autoSend, false);
  assert.equal(station.protoConfig.handshake, true, 'and back the other way');

  await station.disconnect();
});

test('detecting is skipped while a read is already running', async () => {
  const { sim, station } = readout({ autoRead: false });
  await station.connect();
  sim.insertCard(8549150);

  station.busy = true;
  assert.equal(await station.detectCard(), null, 'no overlapping reads');
  station.busy = false;

  assert.notEqual(await station.detectCard({ read: false }), null);
  await station.disconnect();
});
