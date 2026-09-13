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
