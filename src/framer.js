// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2008-2023 Gaudenz Steinlin, Simon Harston, Jan Vorwerk,
//                         Per Magnusson (sireader2.py)
// Copyright (C) 2026 dulcilubio (JavaScript port)
// See NOTICE and LICENSE at the repository root.

/**
 * Incremental frame parser.
 *
 * This is where the port differs most from the Python original. `sireader2.py`
 * reads a frame by making a series of blocking `serial.read(n)` calls, which
 * assumes it can stop the world until the bytes turn up. Web Serial hands you
 * whatever arrived, in chunks of whatever size the driver felt like, so instead
 * we feed bytes into a small state machine and it hands back whole frames.
 *
 * Extended protocol frame layout:
 *
 *     STX  CMD  LEN  STATION(2)  DATA(LEN-2)  CRC(2)  ETX
 *
 * LEN counts the two station bytes plus the data, so the whole frame is
 * LEN + 6 bytes. The CRC covers CMD, LEN, STATION and DATA.
 */

import { crc16, crcCheck, hex, toInt } from './bytes.js';
import { ACK, ETX, NAK, STX, WAKEUP } from './constants.js';

/**
 * @typedef {object} SIFrame
 * @property {number} cmd      Command byte of the reply
 * @property {number} station  Station code that sent the frame
 * @property {Uint8Array} data Payload, without STX, CMD, LEN, station, CRC, ETX.
 *   Note that the first byte of `data` is almost always 0 and is not counted by
 *   the O_* offsets, which is why `extractSysval` adds one.
 * @property {Uint8Array} raw  The complete frame as received
 */

const MAX_BUFFER = 64 * 1024;

export class FrameParser {
  /**
   * @param {object} [handlers]
   * @param {(frame: SIFrame) => void} [handlers.onFrame]
   * @param {() => void} [handlers.onNak]
   * @param {() => void} [handlers.onAck]
   * @param {(reason: string, bytes: Uint8Array) => void} [handlers.onGarbage]
   */
  constructor(handlers = {}) {
    this.onFrame = handlers.onFrame ?? (() => {});
    this.onNak = handlers.onNak ?? (() => {});
    this.onAck = handlers.onAck ?? (() => {});
    this.onGarbage = handlers.onGarbage ?? (() => {});
    this.buffer = new Uint8Array(0);
  }

  /** Drop everything buffered. Called before sending a fresh command. */
  reset() {
    const dropped = this.buffer;
    this.buffer = new Uint8Array(0);
    return dropped;
  }

  /** Number of bytes waiting to be parsed. The analogue of `inWaiting()`. */
  get pending() {
    return this.buffer.length;
  }

  /**
   * Feed received bytes in. Complete frames are dispatched to the handlers
   * synchronously, in arrival order.
   * @param {Uint8Array} chunk
   */
  push(chunk) {
    if (chunk.length === 0) return;

    if (this.buffer.length + chunk.length > MAX_BUFFER) {
      // Something is very wrong upstream. Keep the tail so we can resynchronise
      // rather than growing without bound.
      this.onGarbage('buffer overflow, discarding', this.buffer);
      this.buffer = new Uint8Array(0);
    }

    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    this.#drain();
  }

  #drain() {
    let pos = 0;
    const buf = this.buffer;

    while (pos < buf.length) {
      const byte = buf[pos];

      // Single-byte traffic that can appear between frames.
      if (byte === WAKEUP) {
        pos += 1;
        continue;
      }
      if (byte === NAK) {
        pos += 1;
        this.onNak();
        continue;
      }
      if (byte === ACK) {
        pos += 1;
        this.onAck();
        continue;
      }
      if (byte !== STX) {
        // Resynchronise: skip to the next plausible start byte.
        const next = buf.indexOf(STX, pos);
        const end = next === -1 ? buf.length : next;
        this.onGarbage('unexpected byte outside a frame', buf.subarray(pos, end));
        pos = end;
        continue;
      }

      // We are at STX. Do we have enough to know the length yet?
      if (pos + 3 > buf.length) break;
      const length = buf[pos + 2];
      const frameEnd = pos + length + 6;
      if (frameEnd > buf.length) break; // wait for more bytes

      const raw = buf.subarray(pos, frameEnd);
      const etx = raw[raw.length - 1];

      if (etx !== ETX) {
        // Either a corrupt frame or a stray 0x02 inside noise. Skip this STX
        // only, so a real frame further along is still found.
        this.onGarbage(
          `expected ETX at the end of the frame, got 0x${etx.toString(16)}`,
          raw
        );
        pos += 1;
        continue;
      }

      const body = raw.subarray(1, raw.length - 3); // CMD, LEN, station, data
      const crc = raw.subarray(raw.length - 3, raw.length - 1);
      if (!crcCheck(body, crc)) {
        this.onGarbage(`CRC check failed on frame ${hex(raw)}`, raw);
        pos += 1;
        continue;
      }

      this.onFrame({
        cmd: raw[1],
        station: toInt(raw.subarray(3, 5)),
        data: raw.slice(5, raw.length - 3),
        raw: raw.slice(),
      });
      pos = frameEnd;
    }

    this.buffer = pos === 0 ? buf : buf.slice(pos);
  }
}

/**
 * Build a command frame ready to write to the port.
 * @param {number} cmd
 * @param {Uint8Array|number[]} parameters
 * @param {boolean} [wakeup] prepend a 0xFF wakeup byte, as sireader2 does
 */
export function buildCommand(cmd, parameters = [], wakeup = true) {
  const params = Uint8Array.from(parameters);
  if (params.length > 0xff) {
    throw new RangeError('Command parameters must be at most 255 bytes');
  }
  const body = new Uint8Array(2 + params.length);
  body[0] = cmd;
  body[1] = params.length;
  body.set(params, 2);

  const crc = crc16(body);
  const frame = new Uint8Array((wakeup ? 1 : 0) + 1 + body.length + 2 + 1);
  let i = 0;
  if (wakeup) frame[i++] = WAKEUP;
  frame[i++] = STX;
  frame.set(body, i);
  i += body.length;
  frame.set(crc, i);
  i += 2;
  frame[i] = ETX;
  return frame;
}
