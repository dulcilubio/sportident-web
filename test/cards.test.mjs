// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dulcilubio
// See NOTICE and LICENSE at the repository root.

/** Card layouts: the punch limits have to match the memory actually read. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CARD } from '../src/constants.js';
import { cardTypeFromNumber, decodeCardData } from '../src/protocol.js';

/** How many 128 byte blocks readCardRaw() hands the decoder for each type. */
const BLOCKS_READ = { SI5: 1, SI6: 3, SI8: 2, SI9: 2, pCard: 2, SI10: 5 };

test('every card type can hold exactly the punches it claims', () => {
  for (const [type, layout] of Object.entries(CARD)) {
    const bytes = BLOCKS_READ[type] * 128;
    const fits = Math.floor((bytes - layout.P1) / layout.PL);
    assert.ok(
      layout.PM <= fits,
      `${type}: PM ${layout.PM} would read past the ${bytes} bytes available (room for ${fits})`
    );
    assert.equal(
      layout.PM,
      type === 'SI5' ? 30 : fits, // SI5's last six punches carry no time
      `${type}: PM ${layout.PM} leaves room for ${fits} unused`
    );
  }
});

test('the documented record counts are what we use', () => {
  // From SPORTident's card overview.
  assert.equal(CARD.SI5.PM, 30);
  assert.equal(CARD.SI6.PM, 64);
  assert.equal(CARD.SI8.PM, 30);
  assert.equal(CARD.SI9.PM, 50);
  assert.equal(CARD.SI10.PM, 128, 'SI10, SI11 and SIAC all hold 128');
});

test('a SIAC with more than 64 punches keeps all of them', () => {
  // The old limit of 64 silently dropped the rest, which on a long course is
  // the difference between a valid run and a mispunch.
  const layout = CARD.SI10;
  const data = new Uint8Array(5 * 128).fill(0xee);

  const count = 100;
  data[layout.RC] = count;
  const base = 8 * 3600; // 08:00, comfortably inside the morning half day
  for (let i = 0; i < count; i++) {
    const at = layout.P1 + i * layout.PL;
    data[at + layout.PTD] = 0b0001100; // Saturday, am
    data[at + layout.CN] = 31 + (i % 60);
    const seconds = base + i * 60;
    data[at + layout.PTH] = (seconds >> 8) & 0xff;
    data[at + layout.PTL] = seconds & 0xff;
  }

  const card = decodeCardData(data, 'SI10', new Date());
  assert.equal(card.punchCount, count, 'the card reports 100');
  assert.equal(card.punches.length, count, 'and all 100 come back');
});

test('card numbers map to the type that can read them', () => {
  assert.equal(cardTypeFromNumber(8549150), 'SI10', 'a SIAC reads like an SI10');
  assert.equal(cardTypeFromNumber(2000001), 'SI8');
  assert.equal(cardTypeFromNumber(1000001), 'SI9');
  assert.equal(cardTypeFromNumber(600000), 'SI6');
  assert.equal(cardTypeFromNumber(400000), 'SI5');
});

test('a slot with the subsecond flag has no code, and keeps the fraction', () => {
  // Read off a SIAC: day byte 0x8d, 0x94 beside it, which Config+ reports as
  // an empty code at 20:47:46.578. 148/256 is .578 exactly.
  const layout = CARD.SI10;
  const data = new Uint8Array(5 * 128).fill(0xee);
  data[layout.CN2] = 0x82;
  data[layout.CN1] = 0x73;
  data[layout.CN0] = 0x1e;
  data[layout.RC] = 0;

  const seconds = 20 * 3600 + 47 * 60 + 46 - 43200; // pm half day
  data[layout.FTD] = 0x8d; // bit 7 set: the next byte is a subsecond
  data[layout.FN] = 0x94; // 148
  data[layout.FT] = (seconds >> 8) & 0xff;
  data[layout.FT + 1] = seconds & 0xff;

  const card = decodeCardData(data, 'SI10', new Date(2026, 8, 13, 12, 0, 0));

  assert.equal(card.finishCode, null, 'no station code in this record');
  assert.equal(card.finish.getHours(), 20);
  assert.equal(card.finish.getMinutes(), 47);
  assert.equal(card.finish.getSeconds(), 46);
  assert.equal(card.finish.getMilliseconds(), 578, '148/256 of a second');
});

test('a slot without the flag still has a station code', () => {
  // Read off an SI-Card 8: day byte 0x0c, 0x0d beside it, station code 13.
  const layout = CARD.SI8;
  const data = new Uint8Array(2 * 128).fill(0xee);
  data[layout.CN2] = 0x20;
  data[layout.CN1] = 0x70;
  data[layout.CN0] = 0x8e;
  data[layout.RC] = 0;

  const seconds = 11 * 3600 + 17 * 60 + 11;
  data[layout.FTD] = 0x0c; // bit 7 clear
  data[layout.FN] = 0x0d; // 13
  data[layout.FT] = (seconds >> 8) & 0xff;
  data[layout.FT + 1] = seconds & 0xff;

  const card = decodeCardData(data, 'SI8', new Date(2026, 8, 13, 12, 0, 0));

  assert.equal(card.finishCode, 13, 'a real control code');
  assert.equal(card.finish.getMilliseconds(), 0, 'and no invented fraction');
});

test('the subsecond flag never invents a code of 660', () => {
  // Reading 0x94 as a code and adding the day byte's top bits gave 148 + 512.
  const layout = CARD.SI10;
  const data = new Uint8Array(5 * 128).fill(0xee);
  data[layout.CN2] = 0x82;
  data[layout.CN1] = 0x73;
  data[layout.CN0] = 0x1e;
  data[layout.RC] = 0;
  data[layout.FTD] = 0x8d;
  data[layout.FN] = 0x94;
  data[layout.FT] = 0x7b;
  data[layout.FT + 1] = 0xb2;

  const card = decodeCardData(data, 'SI10', new Date(2026, 8, 13, 12, 0, 0));
  assert.notEqual(card.finishCode, 660);
  assert.equal(card.finishCode, null);
});

test('punch records still carry codes above 255 in the day byte', () => {
  // The subsecond rule applies only to the start/finish/check/clear slots. In
  // a punch the top bits of the day byte really are the top bits of the code.
  const layout = CARD.SI10;
  const data = new Uint8Array(5 * 128).fill(0xee);
  data[layout.RC] = 1;
  const at = layout.P1;
  data[at + layout.PTD] = 0b1000_1100; // top code bits 0b10, Saturday, am
  data[at + layout.CN] = 100;
  const seconds = 9 * 3600;
  data[at + layout.PTH] = (seconds >> 8) & 0xff;
  data[at + layout.PTL] = seconds & 0xff;

  const card = decodeCardData(data, 'SI10', new Date(2026, 8, 13, 12, 0, 0));
  assert.equal(card.punches.length, 1);
  assert.equal(card.punches[0].code, 612, '100 + (0b10 << 8)');
});

test('the offline cache lists every module the page loads', async () => {
  // A file added to src/ but not to the service worker shell would work in
  // development and fail in a forest, which is the worst possible place to
  // find out.
  const { readdirSync, readFileSync } = await import('node:fs');

  const shell = readFileSync(new URL('../demo/sw.js', import.meta.url), 'utf8');
  const cached = new Set(
    [...shell.matchAll(/'\.\.\/src\/([\w.-]+\.js)'/g)].map((m) => m[1])
  );
  const onDisk = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js'));

  const missing = onDisk.filter((f) => !cached.has(f));
  assert.deepEqual(missing, [], `these are not in the service worker shell: ${missing}`);

  const stale = [...cached].filter((f) => !onDisk.includes(f));
  assert.deepEqual(stale, [], `these are cached but no longer exist: ${stale}`);
});
