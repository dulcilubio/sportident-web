// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2008-2023 Gaudenz Steinlin, Simon Harston, Jan Vorwerk,
//                         Per Magnusson (sireader2.py)
// Copyright (C) 2026 dulcilubio (JavaScript port)
// See NOTICE and LICENSE at the repository root.

/**
 * SIControl: a station configured as a control in autosend mode, the equivalent
 * of `SIReaderControl` in sireader2.py.
 *
 * Punches arrive as `punch` events. Each autosend record carries its position
 * in the station's backup memory, so if a punch goes missing on the wire the
 * gap shows up as a jump in that position; this class reads the missing records
 * back out of the memory and emits them in order, flagged as recovered.
 */

import { toInt } from './bytes.js';
import { BC_CN, BC_TIME, CMD, REC_LEN, T_CN, T_OFFSET, T_TIME } from './constants.js';
import { SIProtocolError } from './errors.js';
import { decodeCardNumber, decodeTime } from './protocol.js';
import { SIStation } from './station.js';

export class SIControl extends SIStation {
  /**
   * @param {object} transport
   * @param {object} [options] everything SIStation takes, plus:
   * @param {boolean} [options.recoverMissedPunches] default true
   */
  constructor(transport, options = {}) {
    super(transport, options);
    this.recoverMissedPunches = options.recoverMissedPunches ?? true;
    this.nextOffset = null;
    /** Every punch seen in this session, newest last. */
    this.punches = [];
  }

  #recovering = Promise.resolve();

  /** Throws unless the station is set up to send punches as they happen. */
  assertAutosendMode() {
    if (!this.protoConfig?.extendedProtocol) {
      throw new SIProtocolError(
        'This station is in legacy protocol mode. Switch it to the extended protocol first.'
      );
    }
    if (!this.protoConfig.autoSend) {
      throw new SIProtocolError(
        'This station does not send punches as they happen. Turn on autosend first.'
      );
    }
  }

  handleUnsolicited(frame) {
    if (frame.cmd !== CMD.TRANS_REC) {
      super.handleUnsolicited(frame);
      return;
    }

    const punch = {
      cardNumber: decodeCardNumber(frame.data.subarray(T_CN, T_CN + 4)),
      time: decodeTime(frame.data.subarray(T_TIME, T_TIME + 2)),
      memoryOffset: toInt(frame.data.subarray(T_OFFSET, T_OFFSET + 3)),
      recovered: false,
    };

    const gapStart = this.nextOffset;
    this.nextOffset = punch.memoryOffset + REC_LEN;

    if (
      this.recoverMissedPunches &&
      gapStart !== null &&
      gapStart < punch.memoryOffset
    ) {
      // Emit the recovered punches before this one so the order stays right.
      this.#recovering = this.#recovering
        .then(() => this.#recoverRange(gapStart, punch.memoryOffset))
        .then(() => this.#emit(punch))
        .catch((error) => {
          this.dispatchEvent(new CustomEvent('error', { detail: { error } }));
          this.#emit(punch);
        });
      return;
    }

    this.#emit(punch);
  }

  async #recoverRange(from, to) {
    for (let offset = from; offset < to; offset += REC_LEN) {
      const punch = await this.readPunchAt(offset);
      punch.recovered = true;
      this.#emit(punch);
    }
  }

  #emit(punch) {
    this.punches.push(punch);
    this.dispatchEvent(new CustomEvent('punch', { detail: punch }));
  }

  /**
   * Read a single punch back out of the backup memory.
   * @param {number} offset byte position in the backup memory
   * @warning Only firmware 5.55 and later use this record format.
   */
  async readPunchAt(offset) {
    const data = await this.readBackupRecord(offset, REC_LEN);
    return {
      cardNumber: decodeCardNumber(
        Uint8Array.of(0x00, data[BC_CN], data[BC_CN + 1], data[BC_CN + 2])
      ),
      time: decodeTime(data.subarray(BC_TIME, BC_TIME + 2)),
      memoryOffset: offset,
      recovered: true,
    };
  }

  /**
   * Collect punches that arrive within a window. Mostly useful for scripts;
   * event listeners are the better fit for an interface.
   * @param {number} [milliseconds]
   */
  collectPunches(milliseconds = 1000) {
    return new Promise((resolve) => {
      const collected = [];
      const onPunch = (event) => collected.push(event.detail);
      this.addEventListener('punch', onPunch);
      setTimeout(() => {
        this.removeEventListener('punch', onPunch);
        resolve(collected);
      }, milliseconds);
    });
  }
}
