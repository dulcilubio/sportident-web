/**
 * Byte helpers and the SPORTident CRC.
 * No browser APIs in here, so this module runs in Node for testing.
 */

import { CRC_BITF, CRC_POLYNOM } from './constants.js';

/** Big-endian integer from a byte sequence. Mirrors `SIReader._to_int`. */
export function toInt(bytes) {
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = value * 256 + bytes[i];
  }
  return value;
}

/**
 * Big-endian byte string of a fixed length. Mirrors `SIReader._to_str`.
 * @param {number} value
 * @param {number} length
 */
export function toBytes(value, length) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`Cannot encode ${value} as an unsigned integer`);
  }
  if (length < 6 && value >= 2 ** (8 * length)) {
    throw new RangeError(`${value} does not fit in ${length} bytes`);
  }
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
}

/** Concatenate byte sequences and plain byte values into one Uint8Array. */
export function concat(...parts) {
  const chunks = parts.map((p) =>
    typeof p === 'number' ? Uint8Array.of(p) : Uint8Array.from(p)
  );
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Lower-case hex, space separated, for logs. */
export function hex(bytes, separator = ' ') {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(separator);
}

/** Parse a hex string such as "02 f9 01" back into bytes. Useful in tests. */
export function fromHex(text) {
  const clean = text.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error('Hex string has an odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * CRC of a command or response body, as described in the SPORTident
 * programmer's manual. Returns the two CRC bytes, high byte first.
 *
 * This is a direct port of `SIReader._crc`: the input is padded to an even
 * length with one or two zero bytes, the first two bytes seed the register,
 * and the rest are fed through 16 shift-and-xor rounds each.
 */
export function crc16(data) {
  const n = data.length;
  if (n < 1) return Uint8Array.of(0x00, 0x00);

  let crc = n === 1 ? data[0] : (data[0] << 8) | data[1];

  // The Python generator appends two zero bytes when the tail length is even
  // and one when it is odd, so the padded tail is always even and at least
  // two bytes longer than nothing.
  const tailLength = Math.max(n - 2, 0);
  if (tailLength === 0) {
    return Uint8Array.of((crc >> 8) & 0xff, crc & 0xff);
  }
  const padded = new Uint8Array(tailLength + (tailLength % 2 === 0 ? 2 : 1));
  padded.set(data.subarray(2));

  for (let i = 0; i < padded.length; i += 2) {
    let val = (padded[i] << 8) | padded[i + 1];
    for (let j = 0; j < 16; j++) {
      if ((crc & CRC_BITF) !== 0) {
        crc = (crc << 1) & 0xffff;
        if ((val & CRC_BITF) !== 0) crc += 1; // rotate carry
        crc ^= CRC_POLYNOM;
      } else {
        crc = (crc << 1) & 0xffff;
        if ((val & CRC_BITF) !== 0) crc += 1;
      }
      val = (val << 1) & 0xffff;
    }
  }

  crc &= 0xffff;
  return Uint8Array.of(crc >> 8, crc & 0xff);
}

/** True if `crc` (two bytes) matches the CRC of `data`. */
export function crcCheck(data, crc) {
  const expected = crc16(data);
  return expected[0] === crc[0] && expected[1] === crc[1];
}
