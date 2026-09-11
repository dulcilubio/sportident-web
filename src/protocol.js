// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2008-2023 Gaudenz Steinlin, Simon Harston, Jan Vorwerk,
//                         Per Magnusson (sireader2.py)
// Copyright (C) 2026 dulcilubio (JavaScript port)
// See NOTICE and LICENSE at the repository root.

/**
 * Pure decoding and encoding functions.
 *
 * Nothing in here touches the serial port, so all of it runs in Node and is
 * covered by the tests. Times are returned as ordinary local-time `Date`
 * objects, matching the naive `datetime` values the Python library returns.
 */

import { toInt } from './bytes.js';
import { BUL, BUX, CARD, TIME_RESET } from './constants.js';
import { SIProtocolError } from './errors.js';

const DAY = 86400;
const NOON = 43200;

/** Python-style modulo: the result always has the sign of the divisor. */
function mod(n, m) {
  return ((n % m) + m) % m;
}

/** Monday = 0 ... Sunday = 6, matching `datetime.weekday()`. */
export function weekdayMondayFirst(date) {
  return mod(date.getDay() - 1, 7);
}

/** Local midnight at the start of `date`'s day. */
export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Local midnight of `date`'s day, shifted by a number of seconds. Built with
 * the Date constructor rather than millisecond arithmetic so that it behaves
 * like Python's naive `datetime + timedelta`: wall clock in, wall clock out,
 * with no daylight saving surprises.
 */
export function atSecondsOfDay(date, seconds, milliseconds = 0) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    seconds,
    milliseconds
  );
}

/** Shift a date by whole days, keeping the time of day. */
export function addDays(date, days) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + days,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  );
}

/** Seconds elapsed since local midnight, including fractions. */
export function secondsSinceMidnight(date) {
  return (
    date.getHours() * 3600 +
    date.getMinutes() * 60 +
    date.getSeconds() +
    date.getMilliseconds() / 1000
  );
}

/**
 * Decode a four byte card number.
 *
 * SI-Card 5 stores a series byte and a 16 bit number, and the number printed on
 * the card is 100000 * series + number (series 0 and 1 are not printed). Every
 * later card type stores the printed number directly in the low three bytes.
 * The number ranges are chosen so the two schemes never collide: the smallest
 * SI-Card 6 number, 500000, is larger than the largest possible SI-Card 5
 * number, 465535.
 *
 * @param {Uint8Array} number four bytes, the first of which must be 0
 */
export function decodeCardNumber(number) {
  if (number.length !== 4) {
    throw new SIProtocolError(`Card number must be 4 bytes, got ${number.length}`);
  }
  if (number[0] !== 0x00) {
    throw new SIProtocolError(`Unknown card series 0x${number[0].toString(16)}`);
  }

  const nr = toInt(number.subarray(1, 4));
  if (nr < 500000) {
    // SI-Card 5
    const low = toInt(number.subarray(2, 4));
    // Series 0 and 1 are not printed on the card.
    return number[1] < 2 ? low : number[1] * 100000 + low;
  }
  return nr;
}

/**
 * Map a card number to the data layout used to read it.
 * Returns one of the keys of CARD, or null if the number is not recognised.
 *
 * The WM2003 batch of SI-Card 6 sits inside the SI-Card 8 number range, so a
 * number alone cannot always settle it. When the station has already told you
 * which family it saw, use `cardTypeFromDetect` instead.
 */
export function cardTypeFromNumber(cardNumber) {
  if (cardNumber < 500000) return 'SI5';
  // SI-Card 6, including the WM2003 batch and the SI-Card 6* range
  if (cardNumber <= 999999) return 'SI6';
  if (cardNumber >= 2003000 && cardNumber <= 2003400) return 'SI6';
  if (cardNumber >= 16711680 && cardNumber <= 16777215) return 'SI6';
  if (cardNumber >= 1000000 && cardNumber <= 1999999) return 'SI9';
  if (cardNumber >= 2000000 && cardNumber <= 2999999) return 'SI8';
  if (cardNumber >= 4000000 && cardNumber <= 4999999) return 'pCard';
  // 6000000-6999999 is the tCard, 7-7999999 SI10, 8-8999999 SIAC,
  // 9-9999999 SI11. They all read like an SI10.
  if (cardNumber >= 6000000 && cardNumber <= 9999999) return 'SI10';
  if (cardNumber >= 14000000 && cardNumber <= 14999999) return 'SI10'; // fCard
  return null;
}

/**
 * Map a card number reported in an SI9_DET frame. The station has already said
 * the card is an SI-Card 8, 9, 10, 11, pCard or tCard, so the SI-Card 5 and 6
 * ranges are not in play and the WM2003 overlap cannot bite.
 */
export function cardTypeFromDetect(cardNumber) {
  if (cardNumber >= 1000000 && cardNumber <= 1999999) return 'SI9';
  if (cardNumber >= 2000000 && cardNumber <= 2999999) return 'SI8';
  if (cardNumber >= 4000000 && cardNumber <= 4999999) return 'pCard';
  // tCard, SI-Card 10, SIAC and SI-Card 11 all read like an SI-Card 10.
  if (cardNumber >= 6000000 && cardNumber <= 9999999) return 'SI10';
  if (cardNumber >= 14000000 && cardNumber <= 14999999) return 'SI10';
  return null;
}

/**
 * Decode a raw two byte card time into a Date.
 *
 * The card only stores a half-day time plus, on SI-Card 6 and newer, a day of
 * week. The returned time is the most recent moment before `reftime` that fits
 * the data.
 *
 * @param {Uint8Array} rawTime two bytes, seconds since midnight or midday
 * @param {number|null} [ptd] the day byte, if the card has one
 * @param {Date|null} [reftime] defaults to two hours from now, which gives the
 *   station a little slack if the computer clock runs behind
 * @returns {Date|null} null if the card has no time recorded here
 */
export function decodeTime(rawTime, ptd = null, reftime = null) {
  if (toInt(rawTime) === TIME_RESET) return null;

  let ref = reftime ?? new Date(Date.now() + 2 * 3600 * 1000);
  let punchSeconds = toInt(rawTime); // always in the range 0h-12h

  if (ptd !== null && ptd !== undefined) {
    // PTD byte layout, per SPORTident:
    //   bit 0      am/pm
    //   bits 3..1  day of week, 000 = Sunday, 110 = Saturday
    //   bits 5..4  week counter 0..3, relative, unused here
    //   bits 7..6  high bits of the station code
    if ((ptd & 0b1) === 0b1) punchSeconds += NOON;

    const dow = mod(((ptd & 0b1110) >> 1) - 1, 7); // convert to Monday = 0

    if (
      weekdayMondayFirst(ref) === dow &&
      punchSeconds > Math.floor(secondsSinceMidnight(ref))
    ) {
      // Same weekday, but later in the day than the reference: a week ago.
      ref = addDays(ref, -7);
    } else {
      ref = addDays(ref, -mod(weekdayMondayFirst(ref) - dow, 7));
    }
    return atSecondsOfDay(ref, punchSeconds);
  }

  // No day byte, so guess the nearest matching half day before the reference.
  const refSeconds = secondsSinceMidnight(ref);
  if (refSeconds < NOON) {
    return punchSeconds < refSeconds
      ? atSecondsOfDay(ref, punchSeconds) // this morning
      : atSecondsOfDay(ref, punchSeconds - NOON); // yesterday afternoon
  }
  return punchSeconds < refSeconds - NOON
    ? atSecondsOfDay(ref, punchSeconds + NOON) // this afternoon
    : atSecondsOfDay(ref, punchSeconds); // this morning
}

/**
 * Decode a station code. Cards newer than SI-Card 5 keep two extra code bits in
 * the day byte, which allows codes up to 1023.
 */
export function decodeStationCode(rawCode, ptd = null) {
  if (rawCode === null || rawCode === undefined) return null;
  if (ptd === null || ptd === undefined) return rawCode;
  return ((ptd & 0xc0) << 2) + rawCode;
}

/**
 * @typedef {object} SIPunch
 * @property {number} code    Control code
 * @property {Date} time      Punch time
 */

/**
 * @typedef {object} SICardData
 * @property {number} cardNumber
 * @property {string} cardType
 * @property {Date|null} start
 * @property {number|null} startCode
 * @property {Date|null} finish
 * @property {number|null} finishCode
 * @property {Date|null} check
 * @property {number|null} checkCode
 * @property {Date|null} clear     null on cards that do not store it
 * @property {number|null} clearCode
 * @property {SIPunch[]} punches
 * @property {number} punchCount   As reported by the card, before clamping
 */

/**
 * Decode a full card dump.
 *
 * @param {Uint8Array} data raw card data, blocks concatenated
 * @param {keyof CARD} cardType
 * @param {Date|null} [reftime]
 * @returns {SICardData}
 */
export function decodeCardData(data, cardType, reftime = null) {
  const card = CARD[cardType];
  if (!card) throw new SIProtocolError(`Unknown card type '${cardType}'`);

  const need = Math.max(card.P1, card.RC + 1, card.CT + 2);
  if (data.length < need) {
    throw new SIProtocolError(
      `Card data is too short for ${cardType}: got ${data.length} bytes, need at least ${need}`
    );
  }

  const at = (offset) => (offset === null || offset === undefined ? null : data[offset]);
  const pair = (offset) => data.subarray(offset, offset + 2);

  const result = {
    cardType,
    cardNumber: decodeCardNumber(
      Uint8Array.of(0x00, data[card.CN2], data[card.CN1], data[card.CN0])
    ),
  };

  const startDay = at(card.STD);
  result.start = decodeTime(pair(card.ST), startDay, reftime);
  result.startCode = decodeStationCode(at(card.SN), startDay);

  const finishDay = at(card.FTD);
  result.finish = decodeTime(pair(card.FT), finishDay, reftime);
  result.finishCode = decodeStationCode(at(card.FN), finishDay);

  const checkDay = at(card.CTD);
  result.check = decodeTime(pair(card.CT), checkDay, reftime);
  result.checkCode = decodeStationCode(at(card.CHN), checkDay);

  if (card.LT !== null) {
    const clearDay = at(card.LTD);
    result.clear = decodeTime(pair(card.LT), clearDay, reftime);
    result.clearCode = decodeStationCode(at(card.LN), clearDay);
  } else {
    // SI-Card 5, 8, 9, 10 and 11 do not store the clear time.
    result.clear = null;
    result.clearCode = null;
  }

  let punchCount = data[card.RC];
  // On SI-Card 5 the counter is the index of the *next* punch.
  if (cardType === 'SI5') punchCount -= 1;
  result.punchCount = punchCount;
  if (punchCount > card.PM) punchCount = card.PM;
  if (punchCount < 0) punchCount = 0;

  result.punches = [];
  let i = card.P1;
  for (let p = 0; p < punchCount; p++) {
    if (cardType === 'SI5' && i % 16 === 0) {
      // The first byte of each block is reserved for punches 31-36.
      i += 1;
    }
    if (i + card.PL > data.length) break; // truncated dump, keep what we have

    const ptd = card.PTD === null ? null : data[i + card.PTD];
    // Note: the Python original passes the leftover check/clear day byte here
    // instead of this punch's own day byte, which loses the two high code bits
    // for codes above 255. This passes `ptd`, which is what the format says.
    const code = decodeStationCode(data[i + card.CN], ptd);
    const time = decodeTime(data.subarray(i + card.PTH, i + card.PTL + 1), ptd, reftime);

    if (time !== null) result.punches.push({ code, time });
    i += card.PL;
  }

  return result;
}

/**
 * Slice a field out of the system data block returned by GET_SYS_VAL 0x00 0x80.
 * The first byte of the reply is not covered by the O_* offsets, hence the +1.
 *
 * @param {Uint8Array} sysval
 * @param {number} offset one of the O.* constants
 * @param {number} length
 */
export function extractSysval(sysval, offset, length) {
  const start = offset + 1;
  if (sysval.length < start + length) {
    throw new SIProtocolError(
      `System data is too short: need ${start + length} bytes, have ${sysval.length}`
    );
  }
  return sysval.subarray(start, start + length);
}

/**
 * @typedef {object} SIBackupPunch
 * @property {Date} time    Punch time. On an error record this is midnight or
 *                          midday of the recorded date.
 * @property {number} cardNumber
 * @property {string} error Empty when the record is sound, otherwise a code
 *                          such as "ErrA" or "ErrDate"
 */

/**
 * Decode backup memory recorded by a station running the extended protocol.
 * @param {Uint8Array} memory concatenated payloads, records only
 * @returns {SIBackupPunch[]}
 */
export function decodeBackupExtended(memory) {
  const out = [];
  for (let i = 0; i + BUX.SIZE <= memory.length; i += BUX.SIZE) {
    const punch = memory.subarray(i, i + BUX.SIZE);
    let error = '';
    let seconds = 0;
    let milliseconds = 0;

    const cardNumber = decodeCardNumber(
      Uint8Array.of(0x00, punch[BUX.CN], punch[BUX.CN + 1], punch[BUX.CN + 2])
    );

    let year = 2000 + (punch[BUX.YM] >> 2);
    let month = ((punch[BUX.YM] & 0x3) << 2) + (punch[BUX.MDAP] >> 6);
    const day = (punch[BUX.MDAP] & 0x3f) >> 1;
    const pm = punch[BUX.MDAP] & 0x01;

    if (punch[BUX.SECS] >= 0xf0) {
      error = `Err${(punch[BUX.SECS] & 0xf).toString(16).toUpperCase()}`;
    } else {
      seconds = toInt(punch.subarray(BUX.SECS, BUX.SECS + 2));
      milliseconds = (1000 * punch[BUX.MS]) / 256;
    }

    if (month === 0) {
      // Should not happen, but it has been seen. Corrupt memory?
      month += 12;
      year -= 1;
      error += 'ErrDate';
    }
    if (month > 12) {
      month -= 12;
      year += 1;
      error += 'ErrDate';
    }

    seconds += NOON * pm;
    // month is 1-based here, the Date constructor is 0-based.
    const time = new Date(year, month - 1, day, 0, 0, seconds, Math.round(milliseconds));
    out.push({ time, cardNumber, error });
  }
  return out;
}

/**
 * Decode backup memory recorded by a station running the legacy protocol.
 *
 * Legacy records only carry a day of week, so the punch is assumed to have
 * happened within the last seven days and a full date is filled in from `now`.
 *
 * @param {Uint8Array} memory concatenated payloads, records only
 * @param {Date} [now] reference for filling in the date
 * @returns {SIBackupPunch[]}
 */
export function decodeBackupLegacy(memory, now = new Date()) {
  const out = [];
  const nowWeekday = weekdayMondayFirst(now);
  const nowSeconds = secondsSinceMidnight(now);

  for (let i = 0; i + BUL.SIZE <= memory.length; i += BUL.SIZE) {
    const punch = memory.subarray(i, i + BUL.SIZE);
    let error = '';
    let seconds = 0;

    const cardNumber = decodeCardNumber(
      Uint8Array.of(0x00, punch[BUL.CNS], punch[BUL.CN], punch[BUL.CN + 1])
    );

    // Monday = 0. The Python original has an operator precedence slip here
    // (`>>1 - 1` shifts by zero), which garbles the weekday; this is the
    // intended expression.
    const weekday = mod(((punch[BUL.PTD] & 0x0e) >> 1) - 1, 7);
    const pm = punch[BUL.PTD] & 0x01;

    if (punch[BUL.SECS] >= 0xf0) {
      error = `Err${(punch[BUL.SECS] & 0xf).toString(16).toUpperCase()}`;
    } else {
      seconds = toInt(punch.subarray(BUL.SECS, BUL.SECS + 2));
    }
    seconds += NOON * pm;

    // The extra hour of slack covers a station clock that drifted past
    // midnight relative to the computer.
    const dayOffset =
      weekday * DAY + seconds < nowWeekday * DAY + nowSeconds + 3600
        ? nowWeekday - weekday
        : nowWeekday - weekday + 7;

    const time = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + dayOffset,
      0,
      0,
      seconds
    );
    out.push({ time, cardNumber, error });
  }
  return out;
}
