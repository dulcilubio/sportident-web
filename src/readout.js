// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2008-2023 Gaudenz Steinlin, Simon Harston, Jan Vorwerk,
//                         Per Magnusson (sireader2.py)
// Copyright (C) 2026 dulcilubio (JavaScript port)
// See NOTICE and LICENSE at the repository root.

/**
 * SIReadout: a station in "read SI-cards" mode, the equivalent of
 * `SIReaderReadout` in sireader2.py.
 *
 * The Python version asks "is a card in there yet?" in a loop. Here the station
 * tells you: insert a card and a `cardInserted` event fires. With `autoRead` on
 * (the default) the card is then read and acknowledged for you, and the decoded
 * result arrives as a `card` event.
 *
 * ```js
 * const station = await SIReadout.open(port);
 * station.addEventListener('card', (e) => console.log(e.detail.cardNumber));
 * ```
 */

import { toInt } from './bytes.js';
import { CARD, CMD, MODE, P_SI6_CB } from './constants.js';
import { SINakError, SIProtocolError, SITimeoutError } from './errors.js';
import {
  cardTypeFromDetect,
  cardTypeFromNumber,
  decodeCardData,
  decodeCardNumber,
} from './protocol.js';
import { SIStation } from './station.js';

export class SIReadout extends SIStation {
  /**
   * @param {object} transport
   * @param {object} [options] everything SIStation takes, plus:
   * @param {boolean} [options.autoRead] read and acknowledge cards as they are
   *   inserted, default true
   * @param {boolean} [options.autoAck] beep after a successful read, default true
   * @param {boolean} [options.detectOnConnect] look for a card that is already
   *   in the station when connecting, default true
   */
  constructor(transport, options = {}) {
    super(transport, options);
    this.autoRead = options.autoRead ?? true;
    this.autoAck = options.autoAck ?? true;
    this.detectOnConnect = options.detectOnConnect ?? true;

    /** Number of the card currently in the station, or null. */
    this.cardNumber = null;
    /** Data layout of the card currently in the station, or null. */
    this.cardType = null;
    this.busy = false;
  }

  /**
   * Connect, then look for a card that is already sitting in the station.
   *
   * Without this, connecting to a station that already holds a card reads as a
   * fault: everything is configured correctly and nothing happens, because the
   * announcement went out before anyone was listening.
   */
  async connect(options = {}) {
    await super.connect(options);
    if (!this.detectOnConnect) return;
    if (this.protoConfig?.mode !== MODE.READOUT) return;

    try {
      await this.detectCard();
    } catch (error) {
      // Probing is a convenience. A station that will not answer it is still
      // perfectly usable for cards inserted from now on.
      this.dispatchEvent(new CustomEvent('detectFailed', { detail: { error } }));
    }
  }

  /** Throws unless the station can actually read cards. */
  assertReadoutMode() {
    if (!this.protoConfig?.extendedProtocol) {
      throw new SIProtocolError(
        'This station is in legacy protocol mode. Switch it to the extended protocol first.'
      );
    }
    if (this.protoConfig.mode !== MODE.READOUT) {
      throw new SIProtocolError(
        `This station is in ${this.protoConfig.modeName} mode. Switch it to "Read SI-cards" first.`
      );
    }
  }

  handleUnsolicited(frame) {
    switch (frame.cmd) {
      case CMD.SI_REM:
        this.cardNumber = null;
        this.cardType = null;
        this.dispatchEvent(new CustomEvent('cardRemoved'));
        this.notifyCardChanged('The card was taken out during the command');
        return;

      case CMD.SI5_DET:
        this.cardNumber = decodeCardNumber(frame.data.subarray(0, 4));
        this.cardType = 'SI5';
        this.#cardInserted();
        return;

      case CMD.SI6_DET:
        this.cardNumber = toInt(frame.data);
        this.cardType = 'SI6';
        this.#cardInserted();
        return;

      case CMD.SI9_DET: {
        // SI-Card 9 corrupts the first byte of this frame; it carries nothing.
        this.cardNumber = toInt(frame.data.subarray(1));
        this.cardType = cardTypeFromDetect(this.cardNumber);
        if (!this.cardType) {
          this.dispatchEvent(
            new CustomEvent('error', {
              detail: {
                error: new SIProtocolError(
                  `Card ${this.cardNumber} is not a type this library knows how to read`
                ),
              },
            })
          );
          return;
        }
        this.#cardInserted();
        return;
      }

      default:
        super.handleUnsolicited(frame);
    }
  }

  /**
   * Ask the station whether a card is sitting in it right now.
   *
   * Stations announce a card when it goes in, and nothing afterwards. A card
   * already in the slot when the page connects is therefore invisible, which
   * looks exactly like a broken readout: the station is in the right mode, the
   * card is in, and nothing happens. This probes for one instead of waiting.
   *
   * The probe is a real read of the first block, because there is no "is
   * anything there" command. A station with an empty slot answers NAK, which is
   * not an error here.
   *
   * @param {object} [options]
   * @param {boolean} [options.read] read and emit the card as if it had just
   *   been inserted, subject to autoRead. Default true.
   * @returns {Promise<{cardNumber: number, cardType: string}|null>}
   */
  async detectCard({ read = true } = {}) {
    this.assertReadoutMode();
    if (this.busy) return null;

    const found = await this.#probeForCard();
    if (!found) return null;

    this.cardNumber = found.cardNumber;
    this.cardType = found.cardType;
    if (read) this.#cardInserted();
    return found;
  }

  /**
   * Try each card family in turn. SI-Card 8 and later first, since that is
   * nearly everything in use now.
   */
  async #probeForCard() {
    // Block 0 of an SI-Card 8/9/10/11/pCard carries the card number.
    try {
      const block = await this.sendCommand(CMD.GET_SI9, [0x00], { timeout: 3000, retries: 0 });
      const image = block.subarray(1);
      const layout = CARD.SI8; // CN2/CN1/CN0 sit at the same place on all of them
      if (image.length > layout.CN0) {
        const cardNumber = decodeCardNumber(
          Uint8Array.of(0, image[layout.CN2], image[layout.CN1], image[layout.CN0])
        );
        if (cardNumber > 0) return { cardNumber, cardType: cardTypeFromNumber(cardNumber) };
      }
    } catch (err) {
      if (!isEmptySlot(err)) throw err;
    }

    try {
      const frames = await this.sendCommandFrames(CMD.GET_SI6, [0x00], {
        frames: 1,
        timeout: 3000,
        retries: 0,
      });
      const image = frames[0]?.data?.subarray(1);
      const layout = CARD.SI6;
      if (image && image.length > layout.CN0) {
        const cardNumber = decodeCardNumber(
          Uint8Array.of(0, image[layout.CN2], image[layout.CN1], image[layout.CN0])
        );
        if (cardNumber > 0) return { cardNumber, cardType: 'SI6' };
      }
    } catch (err) {
      if (!isEmptySlot(err)) throw err;
    }

    try {
      const image = await this.sendCommand(CMD.GET_SI5, [], { timeout: 3000, retries: 0 });
      const layout = CARD.SI5;
      if (image.length > layout.CN0) {
        const cardNumber = decodeCardNumber(
          Uint8Array.of(0, image[layout.CN2], image[layout.CN1], image[layout.CN0])
        );
        if (cardNumber > 0) return { cardNumber, cardType: 'SI5' };
      }
    } catch (err) {
      if (!isEmptySlot(err)) throw err;
    }

    return null;
  }

  #cardInserted() {
    const detail = { cardNumber: this.cardNumber, cardType: this.cardType };
    this.dispatchEvent(new CustomEvent('cardInserted', { detail }));
    this.notifyCardChanged('A card was put in during the command');

    if (!this.autoRead || this.busy) return;
    this.busy = true;
    const inserted = this.cardNumber;

    this.readCard()
      .then(async (card) => {
        if (this.autoAck) await this.ackCard();
        this.dispatchEvent(new CustomEvent('card', { detail: card }));
      })
      .catch((error) => {
        this.dispatchEvent(
          new CustomEvent('cardError', { detail: { error, cardNumber: inserted } })
        );
      })
      .finally(() => {
        this.busy = false;
      });
  }

  /**
   * Read the card currently in the station.
   * @param {Date|null} [reftime] reference time for resolving half-day punch times
   * @returns {Promise<import('./protocol.js').SICardData>}
   */
  async readCard(reftime = null) {
    this.assertReadoutMode();
    if (!this.cardType) {
      throw new SIProtocolError('There is no card in the station');
    }

    const raw = await this.readCardRaw();
    const card = decodeCardData(raw, this.cardType, reftime);
    card.raw = raw;
    return card;
  }

  /** The undecoded card dump, blocks already stripped of their block number. */
  async readCardRaw() {
    switch (this.cardType) {
      case 'SI5':
        return this.sendCommand(CMD.GET_SI5, [], { timeout: 5000 });

      case 'SI6': {
        // One command, three frames back.
        const frames = await this.sendCommandFrames(CMD.GET_SI6, [P_SI6_CB], {
          frames: 3,
          timeout: 5000,
        });
        return joinBlocks(frames);
      }

      case 'SI8':
      case 'SI9':
      case 'pCard': {
        const blocks = [];
        for (let b = 0; b < CARD[this.cardType].BC; b++) {
          const data = await this.sendCommand(CMD.GET_SI9, [b], { timeout: 5000 });
          blocks.push(data.subarray(1));
        }
        return concatAll(blocks);
      }

      case 'SI10': {
        // Reading SI-Card 10 block by block turned out to be slow and flaky, so
        // ask for all blocks at once like an SI-Card 6 and take five frames.
        const frames = await this.sendCommandFrames(CMD.GET_SI9, [P_SI6_CB], {
          frames: 5,
          timeout: 8000,
        });
        return joinBlocks(frames);
      }

      default:
        throw new SIProtocolError(`Cannot read a card of type ${this.cardType}`);
    }
  }

  /** Make the station beep and blink to show the card was read. */
  async ackCard() {
    await this.writeAck();
  }

  /**
   * Wait until a card is put in. Resolves immediately if one already is.
   * @param {object} [options]
   * @param {number} [options.timeout] milliseconds, 0 for no limit
   * @param {AbortSignal} [options.signal]
   */
  waitForCard({ timeout = 0, signal } = {}) {
    if (this.cardNumber !== null) {
      return Promise.resolve({ cardNumber: this.cardNumber, cardType: this.cardType });
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.removeEventListener('cardInserted', onCard);
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(timer);
      };
      const onCard = (event) => {
        cleanup();
        resolve(event.detail);
      };
      const onAbort = () => {
        cleanup();
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      const timer = timeout
        ? setTimeout(() => {
            cleanup();
            reject(new SIProtocolError('No card was put in before the timeout'));
          }, timeout)
        : null;

      this.addEventListener('cardInserted', onCard);
      signal?.addEventListener('abort', onAbort);
    });
  }

  /**
   * Compatibility shim for code written against the Python API. Returns true if
   * the card state changed since the last call.
   */
  pollCard() {
    const changed = this.cardNumber !== this._lastPolled;
    this._lastPolled = this.cardNumber;
    return changed;
  }
}

/** A station with nothing in the slot refuses the read. That is an answer. */
function isEmptySlot(error) {
  return error instanceof SINakError || error instanceof SITimeoutError;
}

function joinBlocks(frames) {
  return concatAll(frames.map((f) => f.data.subarray(1)));
}

function concatAll(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
