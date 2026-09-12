// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dulcilubio
// See NOTICE and LICENSE at the repository root.

/**
 * SIAC battery lookup, against SPORTident's public API.
 *
 * A SIAC runs on a battery that is not replaceable by the user and lasts a few
 * years. The card itself does not carry its battery date, so the only way to
 * know is to ask SPORTident:
 *
 *   GET https://api.sportident.com/api/rest/v1/products/si-cards/{cardNumber}
 *   -> { cardNumber, batteryDate, replaceBefore }
 *
 * Everything here is optional. The rest of the library never calls it and works
 * offline; this is for showing a runner that their card is due for service.
 *
 * Two things to know before using it in a page:
 *
 * - It needs the network, so it fails when a laptop in a forest has none. Every
 *   failure is reported as SIBatteryLookupError rather than thrown as a raw
 *   fetch error, so a UI can ignore it and carry on.
 * - The API's CORS allowlist is narrow. As of writing it answers browsers on
 *   http://localhost:8080 and nothing else that was tried -- not
 *   localhost:3000, not 127.0.0.1:8080, not a github.io page. From a browser on
 *   any other origin the request fails with an opaque CORS error, which is
 *   indistinguishable from being offline. Ask SPORTident to allowlist your
 *   origin, or proxy the call from your own server. From Node there is no CORS
 *   and it just works.
 */

import { SIError } from './errors.js';

/** Where the lookup goes. Override for a proxy of your own. */
export const SIAC_BATTERY_API = 'https://api.sportident.com/api/rest/v1/products/si-cards/';

/** SIAC card numbers, the only ones the API accepts. */
export const SIAC_RANGE = { first: 8000001, last: 8999999 };

export class SIBatteryLookupError extends SIError {
  constructor(message, options) {
    super(message, options);
    this.name = 'SIBatteryLookupError';
  }
}

/** True for a card number in the SIAC range. */
export function isSiacNumber(cardNumber) {
  return (
    Number.isInteger(cardNumber) &&
    cardNumber >= SIAC_RANGE.first &&
    cardNumber <= SIAC_RANGE.last
  );
}

/** "2029-07-01" -> a Date at local midnight, or null. */
function parseDay(text) {
  if (typeof text !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Ask SPORTident when a SIAC's battery was made and when to replace it.
 *
 * @param {number} cardNumber a SIAC number, 8000001 to 8999999
 * @param {object} [options]
 * @param {string} [options.clientId] sent as X-Sportident-Client-Id. SPORTident
 *   ask for one; support@sportident.com issues them.
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeout] ms before giving up, default 8000
 * @param {string} [options.baseUrl] override the endpoint, e.g. your own proxy
 * @param {typeof globalThis.fetch} [options.fetch] override for tests
 * @returns {Promise<SIBattery|null>} null when SPORTident has no record of the card
 */
export async function fetchSiacBattery(cardNumber, options = {}) {
  const {
    clientId,
    signal,
    timeout = 8000,
    baseUrl = SIAC_BATTERY_API,
    fetch: fetchImpl = globalThis.fetch,
  } = options;

  if (!isSiacNumber(cardNumber)) {
    throw new SIBatteryLookupError(
      `${cardNumber} is not a SIAC number. Only ${SIAC_RANGE.first} to ${SIAC_RANGE.last} ` +
        'have a battery to check.'
    );
  }
  if (typeof fetchImpl !== 'function') {
    throw new SIBatteryLookupError('No fetch available. Pass one in options.fetch.');
  }

  // Give up rather than hang, but do not clobber a caller's own signal.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;

  let response;
  try {
    response = await fetchImpl(`${baseUrl}${cardNumber}`, {
      method: 'GET',
      headers: clientId ? { 'X-Sportident-Client-Id': clientId } : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    // A CORS refusal and a dead network look identical from here, so say both.
    throw new SIBatteryLookupError(
      `Could not reach the SPORTident battery API: ${err.message}. Either there is no ` +
        "network, or this page's origin is not on the API's CORS allowlist.",
      { cause: err }
    );
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new SIBatteryLookupError(
      `The SPORTident battery API answered ${response.status} for card ${cardNumber}`
    );
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new SIBatteryLookupError('The battery API returned something that is not JSON', {
      cause: err,
    });
  }

  return describeBattery({
    cardNumber: Number(body.cardNumber ?? cardNumber),
    batteryDate: parseDay(body.batteryDate),
    replaceBefore: parseDay(body.replaceBefore),
    raw: body,
  });
}

/**
 * @typedef {object} SIBattery
 * @property {number} cardNumber
 * @property {Date|null} batteryDate    when the battery was made
 * @property {Date|null} replaceBefore  when SPORTident says to replace it
 * @property {'ok'|'due'|'overdue'|'unknown'} status
 * @property {number|null} daysRemaining negative once overdue
 * @property {object} raw               the API response, for fields added later
 */

/** Work out how urgent the replacement is. `now` is injectable for tests. */
export function describeBattery(battery, now = new Date()) {
  const { replaceBefore } = battery;
  if (!replaceBefore) return { ...battery, status: 'unknown', daysRemaining: null };

  const day = 24 * 60 * 60 * 1000;
  const daysRemaining = Math.round((replaceBefore.getTime() - now.getTime()) / day);

  let status = 'ok';
  if (daysRemaining < 0) status = 'overdue';
  else if (daysRemaining <= 90) status = 'due'; // a season's notice

  return { ...battery, status, daysRemaining };
}
