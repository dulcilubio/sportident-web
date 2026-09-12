// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dulcilubio
// See NOTICE and LICENSE at the repository root.

/**
 * SIAC battery lookup. Every test injects its own fetch, so the suite never
 * touches the network.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeBattery,
  fetchSiacBattery,
  isSiacNumber,
  SIBatteryLookupError,
  SIAC_RANGE,
} from '../src/battery.js';

const ok = (body) => async () => ({
  ok: true,
  status: 200,
  json: async () => body,
});

/** The real answer for card 8549150, captured from the API. */
const REAL = { cardNumber: '8549150', batteryDate: '2026-07-01', replaceBefore: '2029-07-01' };

test('only SIAC numbers have a battery to check', () => {
  assert.equal(isSiacNumber(8549150), true);
  assert.equal(isSiacNumber(SIAC_RANGE.first), true);
  assert.equal(isSiacNumber(SIAC_RANGE.last), true);
  assert.equal(isSiacNumber(SIAC_RANGE.first - 1), false);
  assert.equal(isSiacNumber(SIAC_RANGE.last + 1), false);
  assert.equal(isSiacNumber(1234567), false, 'an SI9 has no battery');
  assert.equal(isSiacNumber(8549150.5), false);
});

test('a non-SIAC card is refused without a request going out', async () => {
  let called = false;
  await assert.rejects(
    () => fetchSiacBattery(1234567, { fetch: async () => ((called = true), ok({})()) }),
    /not a SIAC number/
  );
  assert.equal(called, false, 'nothing was sent');
});

test('a real answer is parsed into dates and a status', async () => {
  const battery = await fetchSiacBattery(8549150, { fetch: ok(REAL) });

  assert.equal(battery.cardNumber, 8549150, 'comes back as a number');
  assert.equal(battery.batteryDate.getFullYear(), 2026);
  assert.equal(battery.batteryDate.getMonth(), 6, 'July');
  assert.equal(battery.batteryDate.getDate(), 1);
  assert.equal(battery.replaceBefore.getFullYear(), 2029);
  assert.deepEqual(battery.raw, REAL, 'the untouched body is kept for new fields');
});

test('the client id is sent only when given', async () => {
  let seen;
  const spy = async (url, init) => ((seen = init), ok(REAL)());

  await fetchSiacBattery(8549150, { fetch: spy });
  assert.equal(seen.headers, undefined, 'no header without an id');

  await fetchSiacBattery(8549150, { fetch: spy, clientId: 'abc123' });
  assert.equal(seen.headers['X-Sportident-Client-Id'], 'abc123');
});

test('the card number lands in the path', async () => {
  let url;
  await fetchSiacBattery(8549150, {
    fetch: async (u) => ((url = u), ok(REAL)()),
  });
  assert.match(url, /\/si-cards\/8549150$/);
});

test('a card SPORTident has no record of gives null, not an error', async () => {
  const battery = await fetchSiacBattery(8549150, {
    fetch: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(battery, null);
});

test('a failed request says CORS as well as network, since they look alike', async () => {
  await assert.rejects(
    () =>
      fetchSiacBattery(8549150, {
        fetch: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    (err) => {
      assert.ok(err instanceof SIBatteryLookupError);
      assert.match(err.message, /no network/);
      assert.match(err.message, /CORS allowlist/);
      return true;
    }
  );
});

test('a server error is reported with its status', async () => {
  await assert.rejects(
    () => fetchSiacBattery(8549150, { fetch: async () => ({ ok: false, status: 500 }) }),
    /answered 500/
  );
});

test('the lookup gives up rather than hanging forever', async () => {
  const started = Date.now();
  await assert.rejects(
    () =>
      fetchSiacBattery(8549150, {
        timeout: 150,
        fetch: (url, init) =>
          new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      }),
    /Could not reach/
  );
  assert.ok(Date.now() - started < 2000, 'it did not wait around');
});

test('status turns urgent as the replace date approaches', () => {
  const replaceBefore = new Date(2029, 6, 1);
  const base = { cardNumber: 8549150, batteryDate: new Date(2026, 6, 1), raw: {} };

  const far = describeBattery({ ...base, replaceBefore }, new Date(2027, 0, 1));
  assert.equal(far.status, 'ok');
  assert.ok(far.daysRemaining > 90);

  const soon = describeBattery({ ...base, replaceBefore }, new Date(2029, 5, 1));
  assert.equal(soon.status, 'due', 'within a season');

  const past = describeBattery({ ...base, replaceBefore }, new Date(2029, 8, 1));
  assert.equal(past.status, 'overdue');
  assert.ok(past.daysRemaining < 0);
});

test('a missing replace date is unknown rather than overdue', () => {
  const battery = describeBattery({
    cardNumber: 8549150,
    batteryDate: null,
    replaceBefore: null,
    raw: {},
  });
  assert.equal(battery.status, 'unknown');
  assert.equal(battery.daysRemaining, null);
});

test('a malformed date is treated as missing, not as a crash', async () => {
  const battery = await fetchSiacBattery(8549150, {
    fetch: ok({ cardNumber: '8549150', batteryDate: 'soon', replaceBefore: null }),
  });
  assert.equal(battery.batteryDate, null);
  assert.equal(battery.status, 'unknown');
});
