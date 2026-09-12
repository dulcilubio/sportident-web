// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dulcilubio
// See NOTICE and LICENSE at the repository root.

/**
 * The SIAC special functions.
 *
 * The numbers here were read off four BSF8s configured with Config+, not
 * guessed: battery test 123, ON 124, OFF 125, radio readout 127. 126 is a gap.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SIStation } from '../src/station.js';
import { SimulatedTransport } from '../src/simulator.js';
import { MODE, SIAC_FUNCTIONS, siacFunctionByKey, siacFunctionFor } from '../src/constants.js';

async function connected() {
  const sim = new SimulatedTransport({ latency: 0 });
  const station = new SIStation(sim, { retries: 0, timeout: 800 });
  await station.connect();
  return { sim, station };
}

test('the functions carry the mode and code read off real stations', () => {
  const expected = [
    ['battery-test', 0x01, 123],
    ['on', 0x01, 124],
    ['off', 0x01, 125],
    ['radio-readout', 0x01, 127],
    ['test', 0x11, 124],
  ];
  for (const [key, mode, code] of expected) {
    const f = siacFunctionByKey(key);
    assert.equal(f.mode, mode, `${key} mode`);
    assert.equal(f.code, code, `${key} code`);
  }
  assert.equal(SIAC_FUNCTIONS.length, expected.length, 'no extras invented');
  assert.equal(siacFunctionFor(0x01, 126), null, '126 is a gap, not a guess');
});

test('code alone does not identify a function', () => {
  // 124 is SIAC ON at mode 0x01 and SIAC test at 0x11. Matching on the code
  // by itself would silently confuse the two.
  assert.equal(siacFunctionFor(0x01, 124).name, 'SIAC ON');
  assert.equal(siacFunctionFor(0x11, 124).name, 'SIAC test');
});

test('setting a function writes both the mode and the code', async () => {
  const { station } = await connected();

  for (const wanted of SIAC_FUNCTIONS) {
    const result = await station.setSiacFunction(wanted.key);
    assert.equal(result.mode, wanted.mode, `${wanted.key} mode`);
    assert.equal(result.code, wanted.code, `${wanted.key} code`);
    assert.equal(station.mode, wanted.mode);
    assert.equal(station.modeName, wanted.name);
  }

  await station.disconnect();
});

test('the mode name says which function, not just "SIAC special"', async () => {
  const { station } = await connected();

  await station.setSiacFunction('off');
  assert.equal(station.modeName, 'SIAC OFF');
  assert.equal(station.siacFunction, 'SIAC OFF');

  await station.setSiacFunction('radio-readout');
  assert.equal(station.modeName, 'SIAC radio readout');

  await station.disconnect();
});

test('a SIAC special station with an unrecognised code still reports honestly', async () => {
  const { station } = await connected();

  // 126 is the gap: a real station could sit there.
  await station.setStationCode(126);
  await station.setModeByte(MODE.SIAC_SPECIAL);

  assert.match(
    station.modeName,
    /SIAC special \(mode 0x1, code 126\)/,
    'named without inventing a meaning'
  );
  assert.equal(station.siacFunction, null, 'and not claimed as a known function');

  await station.disconnect();
});

test('siacFunction is null for a station doing something else', async () => {
  const { station } = await connected();
  await station.setOperatingMode('control');
  assert.equal(station.siacFunction, null);
  await station.disconnect();
});

test('an unknown function name is refused', async () => {
  const { station } = await connected();
  await assert.rejects(() => station.setSiacFunction('sleep'), /Unknown SIAC function "sleep"/);
  await assert.rejects(() => station.setSiacFunction(''), /Unknown SIAC function/);
  await station.disconnect();
});

test('names are forgiving about case and spacing', async () => {
  const { station } = await connected();
  const result = await station.setSiacFunction('  Radio-ReadOut ');
  assert.equal(result.code, 127);
  await station.disconnect();
});
