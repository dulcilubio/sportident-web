// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dulcilubio
// See NOTICE and LICENSE at the repository root.

/** Finding a card that is already in the station, and the punch-handling bits. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SIReadout } from '../src/readout.js';
import { SimulatedTransport } from '../src/simulator.js';
import { MODE, O } from '../src/constants.js';

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

test('a code above 255 survives a later feedback change', async () => {
  // The top two bits of the code live in the feedback byte, so writing
  // feedback naively wipes them: code 300 collapses to 44.
  const { station } = readout();
  await station.connect();

  await station.setStationCode(300);
  assert.equal((await station.readInfo()).code, 300);

  await station.setFeedback({ audible: false, optical: true });
  const info = await station.readInfo();

  assert.equal(info.code, 300, 'the high bits were preserved');
  assert.equal(info.audibleFeedback, false);
  assert.equal(info.opticalFeedback, true);

  await station.disconnect();
});

test('setting feedback leaves the code alone in both directions', async () => {
  const { station } = readout();
  await station.connect();
  await station.setStationCode(1023); // both high bits set

  for (const [audible, optical] of [[true, true], [false, false], [true, false]]) {
    await station.setFeedback({ audible, optical });
    const info = await station.readInfo();
    assert.equal(info.code, 1023, `code survived ${audible}/${optical}`);
    assert.equal(info.audibleFeedback, audible);
    assert.equal(info.opticalFeedback, optical);
  }

  await station.disconnect();
});

test('an out of range control code is refused', async () => {
  const { station } = readout();
  await station.connect();
  await assert.rejects(() => station.setStationCode(0), /between 1 and 1023/);
  await assert.rejects(() => station.setStationCode(1024), /between 1 and 1023/);
  await station.disconnect();
});

test('setModeByte writes values setOperatingMode will not', async () => {
  const { station } = readout();
  await station.connect();

  // 0x01 is the SIAC special family: real, documented by SPORTident, and not
  // in SUPPORTED_MODES, so the guarded call refuses it.
  await assert.rejects(() => station.setOperatingMode(0x01), /Cannot set mode 0x1/);

  const got = await station.setModeByte(0x01);
  assert.equal(got, 0x01, 'the raw write went through');
  // The SIAC family is named by its control code, so the name carries it
  // rather than pretending the mode byte alone says which function it is.
  assert.match(station.modeName, /^SIAC special \(mode 0x1, code \d+\)$/);

  await station.disconnect();
});

test('setModeByte still refuses things that are not a byte', async () => {
  const { station } = readout();
  await station.connect();
  for (const bad of [-1, 256, 1.5, 'off', null]) {
    await assert.rejects(() => station.setModeByte(bad), /A mode byte is 0 to 255/);
  }
  await station.disconnect();
});

test('readInfo re-reads the station rather than serving connect-time state', async () => {
  const { sim, station } = readout();
  await station.connect();
  assert.equal((await station.readInfo()).modeName, 'Readout');

  // Something else reconfigures the station: Config+, a colleague, or the
  // station being swapped for another on the coupling stick.
  sim.sysval[O.MODE] = MODE.CONTROL;
  sim.sysval[O.STATION_CODE] = 77;

  const info = await station.readInfo();
  assert.equal(info.modeName, 'Control', 'the change is visible');
  assert.equal(info.code, 77);
  assert.equal(station.modeName, 'Control', 'and the cached view moved with it');

  await station.disconnect();
});

test('readInfo({cached:true}) is available for a caller that wants it', async () => {
  const { sim, station } = readout();
  await station.connect();
  await station.readInfo();

  sim.sysval[O.MODE] = MODE.CONTROL;
  assert.equal((await station.readInfo({ cached: true })).modeName, 'Readout', 'stale on purpose');
  assert.equal((await station.readInfo()).modeName, 'Control', 'fresh by default');

  await station.disconnect();
});

test('setting the code preserves feedback the station actually has now', async () => {
  const { sim, station } = readout();
  await station.connect();
  await station.readInfo();

  // Beeper and lamp are turned off elsewhere after we last looked.
  sim.sysval[O.FEEDBACK] = sim.sysval[O.FEEDBACK] & ~0b101;

  await station.setStationCode(55);
  const info = await station.readInfo();

  assert.equal(info.code, 55);
  assert.equal(info.audibleFeedback, false, 'the current setting survived, not a stale copy');
  assert.equal(info.opticalFeedback, false);

  await station.disconnect();
});
