// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dulcilubio
// See NOTICE and LICENSE at the repository root.

/**
 * The parts of a card that are not punches: who it belongs to, and what it is.
 *
 * These live in the card image at fixed addresses, so everything here works on
 * a *block addressed* image -- block n at offset n * 128 -- rather than on the
 * subset of blocks readCard() happens to fetch. Use readCardImage().
 *
 * Worked out by reading a SIAC with SPORTident Config+ and matching its export
 * against the bytes. SPORTident do not publish this layout.
 */

import { CARD_TEXT } from './constants.js';

/** Where the holder's details sit, and how long the area is. */
export const HOLDER_AREA = { start: 0x20, end: 0x84 };

/** Where the card describes itself. */
export const CARD_INFO = {
  BATTERY_DATE: 0x1bc, // 3 bytes, YY MM DD
  HARDWARE: 0x1c0, // 2 bytes, major minor
  SOFTWARE: 0x1c2, // 2 bytes, major minor
  TYPE_TAG: 0x1f0, // 4 ascii bytes, "siac" on a SIAC
};

/**
 * The holder fields, in the order the card stores them.
 *
 * This is not the order SPORTident's CSV export uses, which is why it has to
 * be read off a card rather than assumed from an export.
 */
export const HOLDER_FIELDS = [
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
];

/** 0xEE is unwritten card memory, 0x00 pads the end of a shorter string. */
const isFiller = (b) => b === 0xee || b === 0x00;

/**
 * Decode the text area to a string.
 *
 * Cards store text in a DOS code page, not Latin-1: 0x84 is "ä", not "„". The
 * card's own character set byte says which, and code page 437 covers what is
 * seen in practice.
 *
 * @param {Uint8Array} bytes
 */
export function decodeCardText(bytes) {
  let out = '';
  for (const b of bytes) {
    if (isFiller(b)) break;
    out += b < 0x80 ? String.fromCharCode(b) : (CARD_TEXT[b] ?? '�');
  }
  return out;
}

/**
 * Who the card belongs to.
 *
 * Every field is a string, empty when the card does not carry it. Cards with
 * nothing written return every field empty rather than null, so a caller can
 * render them without checking.
 *
 * @param {Uint8Array} image a block addressed card image
 * @returns {SICardHolder}
 */
export function decodeCardHolder(image) {
  const holder = Object.fromEntries(HOLDER_FIELDS.map((f) => [f, '']));
  holder.raw = '';
  if (image.length < HOLDER_AREA.end) return holder;

  const text = decodeCardText(image.subarray(HOLDER_AREA.start, HOLDER_AREA.end));
  holder.raw = text;
  if (text === '') return holder;

  const parts = text.split(';');
  HOLDER_FIELDS.forEach((field, i) => {
    holder[field] = (parts[i] ?? '').trim();
  });
  return holder;
}

/** "1a 07 01" -> "2026-07-01". Null when the bytes are unwritten. */
function decodeCardDate(bytes) {
  if (bytes.some(isFiller)) return null;
  const [y, m, d] = bytes;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `20${pad(y)}-${pad(m)}-${pad(d)}`;
}

/** "07 05" -> "7.5" */
function decodeVersion(bytes) {
  if (bytes.some(isFiller)) return null;
  return `${bytes[0]}.${bytes[1]}`;
}

/**
 * What the card is: versions, battery date, and the type it calls itself.
 *
 * @param {Uint8Array} image a block addressed card image
 * @returns {SICardHardware}
 */
export function decodeCardHardware(image) {
  const at = (offset, length) =>
    image.length >= offset + length ? image.subarray(offset, offset + length) : null;

  const tag = at(CARD_INFO.TYPE_TAG, 4);
  const typeTag = tag ? decodeCardText(tag).replace(/[^\x20-\x7e]/g, '') : '';

  return {
    hardwareVersion: at(CARD_INFO.HARDWARE, 2) ? decodeVersion(at(CARD_INFO.HARDWARE, 2)) : null,
    softwareVersion: at(CARD_INFO.SOFTWARE, 2) ? decodeVersion(at(CARD_INFO.SOFTWARE, 2)) : null,
    batteryDate: at(CARD_INFO.BATTERY_DATE, 3)
      ? decodeCardDate(at(CARD_INFO.BATTERY_DATE, 3))
      : null,
    typeTag: /^[a-z0-9]+$/i.test(typeTag) ? typeTag : '',
  };
}
