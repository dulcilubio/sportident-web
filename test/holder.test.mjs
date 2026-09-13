// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dulcilubio
// See NOTICE and LICENSE at the repository root.

/**
 * The holder's details and the card's own description.
 *
 * The layout here was worked out by reading a SIAC with Config+ and matching
 * its export byte for byte. The fixture below is built to that layout with
 * invented details -- a real card image would put someone's name, address and
 * phone number in the repository.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CARD_INFO,
  decodeCardHardware,
  decodeCardHolder,
  decodeCardText,
  HOLDER_AREA,
  HOLDER_FIELDS,
} from '../src/holder.js';

/** Build a card image carrying `text` as the holder area. */
function cardWith(text, { hardware = [7, 5], software = [4, 9], battery = [26, 7, 1], tag = 'siac' } = {}) {
  const image = new Uint8Array(1024).fill(0xee);
  // Latin text goes in as-is; the accented characters are code page 437.
  const cp437 = { ä: 0x84, ö: 0x94, å: 0x86, Ä: 0x8e, Ö: 0x99, Å: 0x8f };
  let at = HOLDER_AREA.start;
  for (const ch of text) {
    image[at++] = cp437[ch] ?? ch.charCodeAt(0);
  }
  image.set(hardware, CARD_INFO.HARDWARE);
  image.set(software, CARD_INFO.SOFTWARE);
  image.set(battery, CARD_INFO.BATTERY_DATE);
  image.set([...tag].map((c) => c.charCodeAt(0)), CARD_INFO.TYPE_TAG);
  return image;
}

test('the holder fields come back in the order the card stores them', () => {
  // Not the order SPORTident's CSV export uses, which is why it is read off
  // a card rather than assumed.
  assert.deepEqual(HOLDER_FIELDS, [
    'firstName',
    'lastName',
    'sex',
    'dateOfBirth',
    'club',
    'email',
    'phone',
    'city',
    'street',
    'postcode',
    'country',
  ]);
});

test('a fully filled card decodes every field', () => {
  const image = cardWith(
    'Ada;Lovelace;Fru;1815-12-10;OK Analytic;ada@example.org;0700000000;Göteborg;Storgatan 1;41100;SE'
  );
  const holder = decodeCardHolder(image);

  assert.equal(holder.firstName, 'Ada');
  assert.equal(holder.lastName, 'Lovelace');
  assert.equal(holder.sex, 'Fru');
  assert.equal(holder.dateOfBirth, '1815-12-10');
  assert.equal(holder.club, 'OK Analytic');
  assert.equal(holder.email, 'ada@example.org');
  assert.equal(holder.phone, '0700000000');
  assert.equal(holder.city, 'Göteborg');
  assert.equal(holder.street, 'Storgatan 1');
  assert.equal(holder.postcode, '41100');
  assert.equal(holder.country, 'SE');
});

test('the holder area is 100 bytes and longer text is cut, not spilled', () => {
  // The area runs 0x20 to 0x84. Text past it belongs to other fields, so a
  // long entry has to stop rather than read on into them.
  assert.equal(HOLDER_AREA.end - HOLDER_AREA.start, 100);

  const long = 'A'.repeat(60) + ';' + 'B'.repeat(60);
  const holder = decodeCardHolder(cardWith(long));
  assert.equal(holder.firstName.length, 60);
  assert.equal(holder.lastName.length, 39, 'cut at the end of the area');
  assert.equal(holder.raw.length, 100);
});

test('accented characters are code page 437, not Latin-1', () => {
  // 0x84 is "ä" on a card. Reading it as Latin-1 gives "„", which is how
  // Swedish and German names come out as gibberish.
  const image = cardWith('Kalle;Källtorp;;;;;;;Källtorpsvägen 18;;');
  const holder = decodeCardHolder(image);
  assert.equal(holder.lastName, 'Källtorp');
  assert.equal(holder.street, 'Källtorpsvägen 18');
});

test('a card with nothing written gives empty fields, not nulls', () => {
  const image = new Uint8Array(1024).fill(0xee);
  const holder = decodeCardHolder(image);
  for (const field of HOLDER_FIELDS) {
    assert.equal(holder[field], '', `${field} should be an empty string`);
  }
  assert.equal(holder.raw, '');
});

test('a partly filled card leaves the rest empty', () => {
  const image = cardWith('Ada;Lovelace;;;OK Analytic;;;;;;');
  const holder = decodeCardHolder(image);
  assert.equal(holder.firstName, 'Ada');
  assert.equal(holder.club, 'OK Analytic');
  assert.equal(holder.email, '');
  assert.equal(holder.country, '');
});

test('text stops at unwritten memory rather than running on', () => {
  assert.equal(decodeCardText(Uint8Array.of(65, 66, 0xee, 67)), 'AB');
  assert.equal(decodeCardText(Uint8Array.of(65, 66, 0x00, 67)), 'AB');
  assert.equal(decodeCardText(Uint8Array.of(0xee)), '');
});

test('the card describes its own versions and battery', () => {
  const hw = decodeCardHardware(cardWith('', { hardware: [7, 5], software: [4, 9], battery: [26, 7, 1] }));
  assert.equal(hw.hardwareVersion, '7.5');
  assert.equal(hw.softwareVersion, '4.9');
  assert.equal(hw.batteryDate, '2026-07-01');
  assert.equal(hw.typeTag, 'siac');
});

test('unwritten hardware bytes read as unknown rather than nonsense', () => {
  const image = new Uint8Array(1024).fill(0xee);
  const hw = decodeCardHardware(image);
  assert.equal(hw.hardwareVersion, null);
  assert.equal(hw.softwareVersion, null);
  assert.equal(hw.batteryDate, null);
  assert.equal(hw.typeTag, '');
});

test('an impossible battery date is refused', () => {
  const hw = decodeCardHardware(cardWith('', { battery: [26, 13, 40] }));
  assert.equal(hw.batteryDate, null, 'month 13 is not a date');
});

test('a short image does not throw', () => {
  const holder = decodeCardHolder(new Uint8Array(16));
  assert.equal(holder.firstName, '');
  const hw = decodeCardHardware(new Uint8Array(16));
  assert.equal(hw.hardwareVersion, null);
});
