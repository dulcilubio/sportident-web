/**
 * A simulated station, for developing without hardware in reach.
 *
 * It speaks the same framing as a real BSM7/8 over the same transport
 * interface, so you can hand it to SIStation, SIReadout or SIControl in place
 * of WebSerialTransport and everything above it behaves normally.
 *
 * ```js
 * const sim = new SimulatedTransport();
 * const station = new SIReadout(sim);
 * await station.connect({ handshake: false });
 * sim.insertCard(8100999);
 * ```
 */

import { concat, crc16, toBytes, toInt } from './bytes.js';
import {
  BAUD_HIGH,
  CARD,
  CMD,
  ETX,
  MODE,
  O,
  STX,
  TIME_RESET,
  WAKEUP,
} from './constants.js';
import { cardTypeFromNumber } from './protocol.js';

const NOON = 43200;

export class SimulatedTransport {
  #buffer = new Uint8Array(0);
  #open = false;

  /**
   * @param {object} [options]
   * @param {number} [options.code] control code the station reports
   * @param {number} [options.mode] one of MODE.*, defaults to readout
   * @param {number} [options.latency] milliseconds before each reply
   * @param {number} [options.serialNumber]
   */
  constructor({
    code = 31,
    mode = MODE.READOUT,
    latency = 12,
    serialNumber = 198765,
  } = {}) {
    this.onData = () => {};
    this.onError = () => {};
    this.onClose = () => {};
    this.baudRate = BAUD_HIGH;
    this.latency = latency;
    this.code = code;

    this.sysval = new Uint8Array(0x80);
    this.sysval.set(toBytes(serialNumber, 4), O.SERIAL_NO);
    this.sysval.set(new TextEncoder().encode('656'), O.FIRMWARE);
    this.sysval.set([26, 4, 17], O.BUILD_DATE);
    this.sysval.set(toBytes(0x9198, 2), O.MODEL_ID); // BSM8-USB
    this.sysval[O.MEM_SIZE] = 128;
    this.sysval.set([25, 11, 2], O.BAT_DATE);
    this.sysval.set(toBytes(Math.round((4000 * 225) / 16), 2), O.BAT_CAP);
    this.sysval.set(toBytes(0x000100, 3), O.USED_BAT_CAP);
    this.sysval.set(toBytes(Math.round((3.42 * 65536) / 5), 2), O.BAT_VOLT);
    this.sysval[O.SI6_CB] = 0xc1;
    this.sysval[O.MODE] = mode;
    this.sysval[O.STATION_CODE] = code & 0xff;
    this.sysval[O.FEEDBACK] = 0b00000101 | ((code >> 8) << 6); // beeper and lamp on
    this.sysval[O.PROTO] = mode === MODE.CONTROL ? 0b011 : 0b101; // extended
    this.sysval.set(toBytes(240, 2), O.ACTIVE_TIME);
    this.sysval.set(toBytes(0x0000, 2), O.BACKUP_PTR_HI);
    this.sysval.set(toBytes(0x0100, 2), O.BACKUP_PTR_LO);

    /** Records the station will hand back from its backup memory. */
    this.backup = new Uint8Array(0);
    this.card = null;
  }

  get isOpen() {
    return this.#open;
  }

  async open() {
    this.#open = true;
  }

  async close() {
    this.#open = false;
    this.onClose();
  }

  async setBaudRate(baudRate) {
    this.baudRate = baudRate;
  }

  async write(bytes) {
    if (!this.#open) throw new Error('The simulated port is not open');
    this.#buffer = concat(this.#buffer, bytes);
    this.#parse();
  }

  #parse() {
    let pos = 0;
    const buf = this.#buffer;
    while (pos < buf.length) {
      if (buf[pos] === WAKEUP) {
        pos += 1;
        continue;
      }
      if (buf[pos] !== STX) {
        pos += 1;
        continue;
      }
      if (pos + 3 > buf.length) break;
      const length = buf[pos + 2];
      const end = pos + length + 6;
      if (end > buf.length) break;
      if (buf[end - 1] === ETX) {
        this.#handle(buf[pos + 1], buf.slice(pos + 3, pos + 3 + length));
      }
      pos = end;
    }
    this.#buffer = buf.slice(pos);
  }

  /** Send a frame from the station to the host. */
  send(cmd, data) {
    const payload = Uint8Array.from(data);
    const body = concat([cmd, payload.length + 2], toBytes(this.code, 2), payload);
    const frame = concat([STX], body, crc16(body), [ETX]);
    setTimeout(() => this.onData(frame), this.latency);
  }

  #handle(cmd, params) {
    switch (cmd) {
      case CMD.SET_MS:
        return this.send(cmd, [params[0]]);

      case CMD.GET_SYS_VAL: {
        const offset = params[0];
        const length = params[1];
        return this.send(cmd, concat([offset], this.sysval.subarray(offset, offset + length)));
      }

      case CMD.SET_SYS_VAL: {
        const offset = params[0];
        this.sysval.set(params.subarray(1), offset);
        return this.send(cmd, [offset]);
      }

      case CMD.GET_TIME:
        return this.send(cmd, encodeTime(new Date()));

      case CMD.SET_TIME:
        return this.send(cmd, params);

      case CMD.BEEP:
        return this.send(cmd, [params[0] ?? 1]);

      case CMD.ERASE_BACKUP:
        this.backup = new Uint8Array(0);
        this.sysval.set(toBytes(0x0100, 2), O.BACKUP_PTR_LO);
        return this.send(cmd, []);

      case CMD.OFF:
        return this.send(cmd, []);

      case CMD.SET_BAUD:
        return this.send(cmd, [params[0]]);

      case CMD.GET_BACKUP: {
        const address = toInt(params.subarray(0, 3));
        const count = params[3];
        const start = address - 0x100;
        const slice = this.backup.subarray(start, start + count);
        const padded = new Uint8Array(count);
        padded.set(slice);
        return this.send(cmd, concat(params.subarray(0, 3), padded));
      }

      case CMD.GET_SI5:
        return this.send(cmd, this.card?.dump ?? new Uint8Array(128));

      case CMD.GET_SI6:
      case CMD.GET_SI9: {
        if (!this.card) return this.send(cmd, [0x00]);
        const blockSize = 128;
        const wantAll = params[0] === 0x08;
        const blocks = wantAll ? Math.ceil(this.card.dump.length / blockSize) : 1;
        const firstBlock = wantAll ? 0 : params[0];
        for (let b = 0; b < blocks; b++) {
          const index = firstBlock + b;
          const chunk = this.card.dump.subarray(index * blockSize, (index + 1) * blockSize);
          const padded = new Uint8Array(blockSize);
          padded.set(chunk);
          this.send(cmd, concat([index], padded));
        }
        return undefined;
      }

      default:
        // Unknown command: NAK, like a real station.
        return setTimeout(() => this.onData(Uint8Array.of(0x15)), this.latency);
    }
  }

  // ------------------------------------------------------------------ scripting

  /**
   * Put a card in. Fires the matching detect frame and remembers a dump for the
   * host to read.
   * @param {number} cardNumber
   * @param {object} [options]
   * @param {Array<{code: number, time: Date}>} [options.punches]
   */
  insertCard(cardNumber, { punches } = {}) {
    const cardType = cardTypeFromNumber(cardNumber) ?? 'SI9';
    const dump = buildCardDump(cardNumber, cardType, punches ?? defaultPunches());
    this.card = { cardNumber, cardType, dump };

    const bytes = toBytes(cardNumber, 4);
    if (cardNumber < 500000) {
      this.send(CMD.SI5_DET, bytes);
    } else if (cardNumber < 1000000) {
      this.send(CMD.SI6_DET, bytes);
    } else {
      this.send(CMD.SI9_DET, concat([0xee], bytes));
    }
  }

  /** Take the card out again. */
  removeCard() {
    const number = this.card?.cardNumber ?? 0;
    this.card = null;
    this.send(CMD.SI_REM, toBytes(number, 4));
  }

  /** Send an autosend punch, as a control in autosend mode would. */
  sendPunch(cardNumber, time = new Date(), memoryOffset = null) {
    const offset = memoryOffset ?? 0x100 + this.backup.length;
    const seconds = secondsOfHalfDay(time);
    const data = concat(
      toBytes(cardNumber, 4),
      [0x00],
      toBytes(seconds, 2),
      [0x00],
      toBytes(offset, 3)
    );
    this.backup = concat(this.backup, buildBackupRecord(cardNumber, time));
    this.sysval.set(toBytes(0x100 + this.backup.length, 2), O.BACKUP_PTR_LO);
    this.send(CMD.TRANS_REC, data);
  }

  /** Fill the backup memory with punches, as if a session had been run. */
  fillBackup(records) {
    this.backup = concat(
      ...records.map((r) => buildBackupRecord(r.cardNumber, r.time))
    );
    this.sysval.set(toBytes(0x100 + this.backup.length, 2), O.BACKUP_PTR_LO);
    this.sysval.set(toBytes(0x0000, 2), O.BACKUP_PTR_HI);
  }
}

// ---------------------------------------------------------------------- helpers

function secondsOfHalfDay(date) {
  return (date.getHours() % 12) * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

function dayByte(date) {
  return (date.getDay() << 1) | (date.getHours() >= 12 ? 1 : 0);
}

function encodeTime(date) {
  return concat(
    [date.getFullYear() % 100, date.getMonth() + 1, date.getDate(), dayByte(date)],
    toBytes(secondsOfHalfDay(date), 2),
    [Math.round((date.getMilliseconds() / 1000) * 256) & 0xff]
  );
}

function buildBackupRecord(cardNumber, time) {
  const record = new Uint8Array(8);
  record.set(toBytes(cardNumber, 3), 0);
  record[3] = ((time.getFullYear() - 2000) << 2) | ((time.getMonth() + 1) >> 2);
  record[4] =
    (((time.getMonth() + 1) & 0x3) << 6) |
    (time.getDate() << 1) |
    (time.getHours() >= 12 ? 1 : 0);
  record.set(toBytes(secondsOfHalfDay(time), 2), 5);
  record[7] = 0x80;
  return record;
}

function defaultPunches() {
  const base = new Date();
  base.setHours(10, 3, 0, 0);
  return [31, 32, 45, 33, 100].map((code, i) => ({
    code,
    time: new Date(base.getTime() + (i + 1) * 97000),
  }));
}

/** Build a card dump that decodeCardData will read back correctly. */
function buildCardDump(cardNumber, cardType, punches) {
  const card = CARD[cardType];
  // How many blocks the station actually sends back: three for SI-Card 6, five
  // for the SI-Card 10 family, otherwise one per block on the card.
  const blocks = cardType === 'SI6' ? 3 : cardType === 'SI10' ? 5 : (card.BC ?? 1);
  const size = Math.max(128 * blocks, card.P1 + punches.length * card.PL + 8);
  const dump = new Uint8Array(Math.ceil(size / 128) * 128);
  dump.fill(0x00);

  const number = toBytes(cardNumber, 4);
  dump[card.CN2] = number[1];
  dump[card.CN1] = number[2];
  dump[card.CN0] = number[3];

  const noTime = toBytes(TIME_RESET, 2);
  dump.set(noTime, card.ST);
  dump.set(noTime, card.FT);
  dump.set(noTime, card.CT);

  const start = punches[0]?.time ?? new Date();
  const startTime = new Date(start.getTime() - 60000);
  if (card.STD !== null) dump[card.STD] = dayByte(startTime);
  if (card.SN !== null) dump[card.SN] = 1;
  dump.set(toBytes(secondsOfHalfDay(startTime), 2), card.ST);

  const finishTime = punches.at(-1)?.time ?? new Date();
  if (card.FTD !== null) dump[card.FTD] = dayByte(finishTime);
  if (card.FN !== null) dump[card.FN] = 2;
  dump.set(toBytes(secondsOfHalfDay(new Date(finishTime.getTime() + 60000)), 2), card.FT);

  dump[card.RC] = cardType === 'SI5' ? punches.length + 1 : punches.length;

  let i = card.P1;
  for (const punch of punches) {
    if (cardType === 'SI5' && i % 16 === 0) i += 1;
    if (card.PTD !== null) dump[i + card.PTD] = dayByte(punch.time);
    dump[i + card.CN] = punch.code & 0xff;
    dump.set(toBytes(secondsOfHalfDay(punch.time), 2), i + card.PTH);
    i += card.PL;
  }

  return dump;
}
