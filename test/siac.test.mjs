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
import { MODE, SIAC_FUNCTION, SIAC_FUNCTION_NAMES } from '../src/constants.js';

async function connected() {
  const sim = new SimulatedTransport({ latency: 0 });
  const station = new SIStation(sim, { retries: 0, timeout: 800 });
  await station.connect();
  return { sim, station };
}

test('the four functions have the codes read off real stations', () => {
  assert.equal(SIAC_FUNCTION.BATTERY_TEST, 123);
  assert.equal(SIAC_FUNCTION.ON, 124);
  assert.equal(SIAC_FUNCTION.OFF, 125);
  assert.equal(SIAC_FUNCTION.RADIO_READOUT, 127);
  assert.equal(SIAC_FUNCTION_NAMES[126], undefined, '126 is a gap, not a guess');
});

test('setting a function writes both the mode and the code', async () => {
  const { station } = await connected();

  for (const [name, code] of [
    ['on', 123 + 1],
    ['off', 125],
    ['battery-test', 123],
    ['radio-readout', 127],
  ]) {
    const result = await station.setSiacFunction(name);
    assert.equal(result.mode, MODE.SIAC_SPECIAL, `${name} sits in the SIAC special mode`);
    assert.equal(result.code, code, `${name} uses code ${code}`);
    assert.equal(station.mode, MODE.SIAC_SPECIAL);
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

  assert.match(station.modeName, /SIAC special \(code 126\)/, 'named without inventing a meaning');
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
  assert.equal(result.code, SIAC_FUNCTION.RADIO_READOUT);
  await station.disconnect();
});
