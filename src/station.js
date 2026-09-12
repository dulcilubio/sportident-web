// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2008-2023 Gaudenz Steinlin, Simon Harston, Jan Vorwerk,
//                         Per Magnusson (sireader2.py)
// Copyright (C) 2026 dulcilubio (JavaScript port)
// See NOTICE and LICENSE at the repository root.

/**
 * SIStation: the base class, equivalent to `SIReader` in sireader2.py.
 *
 * Every method that talks to the station returns a promise. Commands are
 * queued so that two callers cannot interleave on the wire, and replies are
 * matched to commands by an event dispatcher rather than by blocking reads.
 * Anything the station sends on its own initiative, such as a card being
 * inserted or an autosend punch, is delivered as an event.
 */

import { concat, hex, toBytes, toInt } from './bytes.js';
import {
  BAUD_HIGH,
  BAUD_LOW,
  CMD,
  BEACON_MODES,
  BEACON_OLD_TO_NEW,
  MODE,
  MODE_BY_NAME,
  MODE_NAMES,
  MODEL_NAMES,
  O,
  P_MS_DIRECT,
  P_MS_INDIRECT,
  REMOTE_OFF,
  SUPPORTED_MODES,
  SIAC_FUNCTIONS,
  SIAC_MODES,
  siacFunctionByKey,
  siacFunctionFor,
  SUPPORTED_READ_BACKUP_MODES,
  WAKE_TIMEOUT,
  ACK,
  BUL,
  BUX,
} from './constants.js';
import {
  SICardChangedError,
  SIConnectionError,
  SINakError,
  SIProtocolError,
  SITimeoutError,
} from './errors.js';
import { buildCommand, FrameParser } from './framer.js';
import {
  decodeBackupExtended,
  decodeBackupLegacy,
  decodeCardNumber,
  decodeTime,
  extractSysval,
} from './protocol.js';
import { toTransport } from './connect.js';

/** Frames the station can send at any time, without being asked. */
const UNSOLICITED = new Set([
  CMD.SI5_DET,
  CMD.SI6_DET,
  CMD.SI9_DET,
  CMD.SI_REM,
  CMD.TRANS_REC,
  CMD.SRR_PING,
  CMD.SRR_ADHOC,
]);

/** A pause that can be cut short, and that never leaves a timer running. */
function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export class SIStation extends EventTarget {
  #transport;
  #parser;
  #pending = null;
  #queue = Promise.resolve();
  #closed = false;

  /**
   * @param {object} transport anything with open/close/write/setBaudRate and
   *   onData/onError/onClose callbacks, normally a WebSerialTransport
   * @param {object} [options]
   * @param {boolean} [options.debug] log every frame to the console
   * @param {boolean} [options.wakeup] send a 0xFF wakeup byte before commands
   * @param {number}  [options.timeout] milliseconds to wait for a reply
   * @param {number}  [options.retries] extra attempts after a timeout
   * @param {boolean} [options.strictCardChanged] fail a command when a card is
   *   inserted or removed while it is in flight, the way the Python original
   *   does. Off by default, because carrying on is nearly always what you want.
   */
  constructor(transport, options = {}) {
    super();
    this.debug = options.debug ?? false;
    this.wakeup = options.wakeup ?? true;
    this.timeout = options.timeout ?? 2000;
    this.retries = options.retries ?? 1;
    this.strictCardChanged = options.strictCardChanged ?? false;

    /** Most recent system data block, or null. */
    this.sysval = null;
    /** Protocol and mode configuration, refreshed after every change. */
    this.protoConfig = null;
    /** Code of the station that answered last. */
    this.stationCode = null;
    /** Serial number of the station. */
    this.serialNumber = 0;
    /** False once setRemote() has been used. */
    this.direct = true;

    this.#transport = transport;
    transport.onData = (chunk) => {
      this.dispatchEvent(new CustomEvent('rx', { detail: { bytes: chunk } }));
      if (this.debug) console.debug('<<--', hex(chunk));
      this.#parser.push(chunk);
    };
    transport.onError = (err) => this.#fail(err);
    transport.onClose = () => {
      this.#closed = true;
      this.dispatchEvent(new CustomEvent('close'));
    };

    this.#parser = new FrameParser({
      onFrame: (frame) => this.#handleFrame(frame),
      onNak: () => {
        this.dispatchEvent(new CustomEvent('nak'));
        this.#reject(new SINakError());
      },
      onGarbage: (reason, bytes) => {
        this.dispatchEvent(
          new CustomEvent('garbage', { detail: { reason, bytes } })
        );
        if (this.debug) console.warn('SI garbage:', reason, hex(bytes));
      },
    });
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Open a station and shake hands with it.
   *
   * Takes a Web Serial port, a WebUSB device, or a transport that is already
   * built, so the same call works on every platform.
   *
   * @param {SerialPort|USBDevice|object} source from requestStation(),
   *   requestPort() or requestUsbDevice()
   * @param {object} [options] passed to the constructor, plus:
   * @param {number} [options.baudRate] start speed, defaults to 38400
   * @param {boolean} [options.tryLowSpeed] retry at 4800 baud, default true
   * @param {boolean} [options.handshake] send SET_MS on connect, default true
   * @returns {Promise<SIStation>}
   */
  static async open(source, options = {}) {
    const station = new this(toTransport(source), options);
    await station.connect(options);
    return station;
  }

  /** Open the transport and identify the station. */
  async connect({
    baudRate = BAUD_HIGH,
    tryLowSpeed = true,
    handshake = true,
  } = {}) {
    await this.#transport.open({ baudRate });
    this.#closed = false;

    if (handshake) {
      try {
        await this.setDirect();
      } catch (err) {
        if (!(err instanceof SITimeoutError) || !tryLowSpeed || baudRate === BAUD_LOW) {
          throw err;
        }
        // Older stations, and stations that were switched to the legacy speed,
        // only answer at 4800 baud.
        await this.#transport.setBaudRate(BAUD_LOW);
        try {
          await this.setDirect();
        } catch (cause) {
          throw new SIConnectionError(
            'No SPORTident station answered at 38400 or 4800 baud. Is it awake and is this the right port?',
            { cause }
          );
        }
      }
    }

    await this.refreshSysval();
    this.dispatchEvent(new CustomEvent('open'));
    return this;
  }

  /** Close the serial port. */
  async disconnect() {
    this.#reject(new SIConnectionError('The port was closed'));
    await this.#transport.close();
    this.#closed = true;
  }

  get isOpen() {
    return !this.#closed && this.#transport.isOpen;
  }

  get baudRate() {
    return this.#transport.baudRate;
  }

  // ------------------------------------------------------------ command layer

  /**
   * Send a command and wait for the reply.
   *
   * @param {number} cmd one of the CMD.* constants
   * @param {Uint8Array|number[]} [parameters]
   * @param {object} [options]
   * @param {number} [options.frames] how many reply frames to collect. SI-Card 6
   *   answers with three, SI-Card 10 with five.
   * @param {number} [options.responseCmd] expected reply command, defaults to
   *   the command byte that was sent
   * @param {number} [options.timeout]
   * @param {number} [options.retries]
   * @param {boolean} [options.wakeup]
   * @returns {Promise<Uint8Array>} the payload, or the payloads joined when
   *   more than one frame was requested
   */
  async sendCommand(cmd, parameters = [], options = {}) {
    const frames = await this.sendCommandFrames(cmd, parameters, options);
    return frames.length === 1 ? frames[0].data : concat(...frames.map((f) => f.data));
  }

  /** As sendCommand, but returns the raw frames. */
  async sendCommandFrames(cmd, parameters = [], options = {}) {
    const {
      frames = 1,
      responseCmd = cmd,
      timeout = this.timeout,
      retries = this.retries,
      wakeup = this.wakeup,
    } = options;

    return this.#enqueue(async () => {
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await this.#exchange(cmd, parameters, {
            frames,
            responseCmd,
            timeout,
            wakeup: wakeup || attempt > 0, // always wake up on a retry
          });
        } catch (err) {
          lastError = err;
          const worthRetrying =
            err instanceof SITimeoutError || err instanceof SIProtocolError;
          if (!worthRetrying || attempt === retries) throw err;
          if (this.debug) {
            console.warn(`SI retry ${attempt + 1} after ${err.message}`);
          }
        }
      }
      throw lastError;
    });
  }

  async #exchange(cmd, parameters, { frames, responseCmd, timeout, wakeup }) {
    if (!this.isOpen) throw new SIConnectionError('The port is not open');

    const stale = this.#parser.reset();
    if (stale.length && this.debug) {
      console.warn('SI: discarded stale input', hex(stale));
    }

    const bytes = buildCommand(cmd, parameters, wakeup);
    const waiter = this.#expect(responseCmd, frames, timeout);

    this.dispatchEvent(new CustomEvent('tx', { detail: { bytes, cmd } }));
    if (this.debug) console.debug('-->>', hex(bytes));

    try {
      await this.#transport.write(bytes);
    } catch (err) {
      this.#reject(err);
      throw err;
    }
    return waiter;
  }

  /** Send raw bytes, for the handful of commands that are not normal frames. */
  async sendRaw(bytes) {
    return this.#enqueue(async () => {
      this.dispatchEvent(new CustomEvent('tx', { detail: { bytes } }));
      if (this.debug) console.debug('-->>', hex(bytes), '(raw)');
      await this.#transport.write(Uint8Array.from(bytes));
    });
  }

  #enqueue(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  #expect(responseCmd, wanted, timeout) {
    return new Promise((resolve, reject) => {
      const pending = {
        responseCmd,
        wanted,
        frames: [],
        resolve,
        reject,
        timer: null,
      };
      const arm = () => {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
          this.#pending = null;
          reject(
            new SITimeoutError(
              `No reply to command 0x${responseCmd.toString(16)} within ${timeout} ms`
            )
          );
        }, timeout);
      };
      pending.arm = arm;
      arm();
      this.#pending = pending;
    });
  }

  #settle() {
    const pending = this.#pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending = null;
    pending.resolve(pending.frames);
  }

  #reject(error) {
    const pending = this.#pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending = null;
    pending.reject(error);
  }

  #fail(error) {
    this.dispatchEvent(new CustomEvent('error', { detail: { error } }));
    this.#reject(error);
  }

  #handleFrame(frame) {
    this.stationCode = frame.station;
    this.dispatchEvent(new CustomEvent('frame', { detail: frame }));
    if (this.debug) {
      console.debug(
        `<<-- cmd 0x${frame.cmd.toString(16)} station ${frame.station} data ${hex(frame.data)}`
      );
    }

    if (UNSOLICITED.has(frame.cmd)) {
      this.handleUnsolicited(frame);
      return;
    }

    const pending = this.#pending;
    if (!pending) {
      this.dispatchEvent(new CustomEvent('unexpectedFrame', { detail: frame }));
      return;
    }
    if (pending.responseCmd !== null && frame.cmd !== pending.responseCmd) {
      // Most likely a late reply to a command that already timed out. Drop it
      // and keep waiting rather than failing the command in flight.
      this.dispatchEvent(new CustomEvent('unexpectedFrame', { detail: frame }));
      return;
    }

    pending.frames.push(frame);
    if (pending.frames.length >= pending.wanted) {
      this.#settle();
    } else {
      pending.arm(); // more to come, restart the clock
    }
  }

  /**
   * Handle a frame the station sent on its own. Subclasses override this to
   * track card state; the base class turns autosend punches into events.
   */
  handleUnsolicited(frame) {
    if (frame.cmd === CMD.TRANS_REC) {
      const punch = decodeAutosendPunch(frame.data);
      this.dispatchEvent(new CustomEvent('punch', { detail: punch }));
    }
  }

  /** Notify a pending command that the card changed, if strict mode is on. */
  notifyCardChanged(message) {
    if (this.strictCardChanged) this.#reject(new SICardChangedError(message));
  }

  /** Send a bare ACK byte. Makes the station beep after a readout. */
  async writeAck() {
    await this.#transport.write(Uint8Array.of(ACK));
  }

  // -------------------------------------------------------------- system data

  /** Read the whole 128 byte system data block into `this.sysval`. */
  async refreshSysval() {
    this.sysval = await this.sendCommand(CMD.GET_SYS_VAL, [0x00, 0x80]);
    this.#updateProtoConfigFromSysval();
    return this.sysval;
  }

  async #sysvalOrRefresh() {
    if (!this.sysval || this.sysval.length < 0x80) await this.refreshSysval();
    return this.sysval;
  }

  #field(offset, length) {
    return extractSysval(this.sysval, offset, length);
  }

  /**
   * Name a mode byte. The SIAC special family is one byte for four functions,
   * told apart by the control code, so the code has to be read to name it.
   */
  #describeMode(mode) {
    if (SIAC_MODES.includes(mode)) {
      const code = this.#field(O.STATION_CODE, 1)[0] | ((this.#field(O.FEEDBACK, 1)[0] >> 6) << 8);
      const found = siacFunctionFor(mode, code);
      // An unrecognised pair gets named for what it is, not guessed at.
      return found ? found.name : `SIAC special (mode 0x${mode.toString(16)}, code ${code})`;
    }
    return MODE_NAMES[mode] ?? `0x${mode.toString(16).padStart(2, '0')}`;
  }

  #updateProtoConfigFromSysval() {
    const proto = this.#field(O.PROTO, 1)[0];
    const mode = this.#field(O.MODE, 1)[0];
    this.protoConfig = {
      extendedProtocol: (proto & (1 << 0)) !== 0,
      autoSend: (proto & (1 << 1)) !== 0,
      handshake: (proto & (1 << 2)) !== 0,
      passwordAccess: (proto & (1 << 4)) !== 0,
      readCardAfterPunch: (proto & (1 << 7)) !== 0,
      mode,
      modeName: this.#describeMode(mode),
    };
    this.serialNumber = toInt(this.#field(O.SERIAL_NO, 4));
    this.stationCode = this.#stationCodeFromSysval();
    return this.protoConfig;
  }

  #stationCodeFromSysval() {
    const low = this.#field(O.STATION_CODE, 1)[0];
    const feedback = this.#field(O.FEEDBACK, 1)[0]; // also holds the high bits
    return low + ((feedback & 0b11000000) << 2);
  }

  /**
   * Everything worth knowing about the station, decoded from the system data.
   * Reads the block first if it has not been read yet.
   */
  async readInfo() {
    await this.#sysvalOrRefresh();
    const modelId = toInt(this.#field(O.MODEL_ID, 2));
    const si6Blocks = this.#field(O.SI6_CB, 1)[0];
    const activeMinutes = toInt(this.#field(O.ACTIVE_TIME, 2));
    const feedback = this.#field(O.FEEDBACK, 1)[0];

    return {
      serialNumber: toInt(this.#field(O.SERIAL_NO, 4)),
      firmware: new TextDecoder('ascii').decode(this.#field(O.FIRMWARE, 3)),
      modelId,
      modelName:
        MODEL_NAMES[modelId] ?? `0x${modelId.toString(16).padStart(4, '0')}`,
      buildDate: formatSysvalDate(this.#field(O.BUILD_DATE, 3)),
      batteryDate: formatSysvalDate(this.#field(O.BAT_DATE, 3)),
      memorySizeKb: this.#field(O.MEM_SIZE, 1)[0],
      voltage: (toInt(this.#field(O.BAT_VOLT, 2)) * 5) / 65536,
      batteryCapacityMah: (toInt(this.#field(O.BAT_CAP, 2)) * 16) / 225,
      batteryUsedPercent: toInt(this.#field(O.USED_BAT_CAP, 3)) * 2.778e-5,
      memoryOverflow: this.#field(O.MEM_OVERFLOW, 1)[0] !== 0,
      code: this.#stationCodeFromSysval(),
      mode: this.protoConfig.mode,
      modeName: this.protoConfig.modeName,
      activeTimeMinutes: activeMinutes,
      activeTime: `${String(Math.floor(activeMinutes / 60)).padStart(2, '0')}:${String(
        activeMinutes % 60
      ).padStart(2, '0')}:00`,
      protocolByte: this.#field(O.PROTO, 1)[0],
      extendedProtocol: this.protoConfig.extendedProtocol,
      autoSend: this.protoConfig.autoSend,
      feedbackByte: feedback,
      opticalFeedback: (feedback & 0b1) !== 0,
      audibleFeedback: (feedback & 0b100) !== 0,
      // 0x00 and 0xC1 mean three blocks, 0x08 and 0xFF mean all eight
      si6With192Punches:
        si6Blocks === 0x08 || si6Blocks === 0xff
          ? true
          : si6Blocks === 0x00 || si6Blocks === 0xc1
            ? false
            : si6Blocks,
    };
  }

  // ------------------------------------------------------------- station setup

  /** Talk to the station on the cable itself. */
  async setDirect() {
    await this.sendCommand(CMD.SET_MS, [P_MS_DIRECT]);
    this.direct = true;
    this.sysval = null; // the sysval now on hand belongs to the other station
  }

  /**
   * Talk through the cabled station to a second one standing on top of it.
   *
   * The cabled station becomes a radio bridge: every command is relayed to
   * whatever station is sitting on its coupling stick, and the replies come
   * back the same way. That is how Config+ configures a station without
   * plugging it in.
   *
   * Two things to know. The cabled station has to be in extended protocol
   * mode to relay at all, and once this returns, every command you send is
   * aimed at the station on top, not the one on the cable -- including the
   * destructive ones. Prefer `withRemote()`, which puts it back.
   */
  async setRemote() {
    await this.#sysvalOrRefresh();
    if (this.protoConfig && !this.protoConfig.extendedProtocol) {
      throw new SIProtocolError(
        'The cabled station must be in extended protocol mode before it can relay ' +
          'to a remote station. Call setExtendedProtocol() first.'
      );
    }
    await this.sendCommand(CMD.SET_MS, [P_MS_INDIRECT]);
    this.direct = false;
    this.sysval = null; // anything cached describes the cabled station
  }

  /**
   * Keep prodding a sleeping station until it answers.
   *
   * A station on the coupling stick is usually asleep, and one command is not
   * enough to rouse it. Measured on a BSF8 coming out of a real sleep: 31
   * attempts over 22.8 seconds of continuous traffic before the first answer.
   * The default budget is 30 seconds for that reason -- five is not enough,
   * however reasonable it sounds.
   *
   * Nothing here blocks. Each attempt is awaited and the gaps are timers, so
   * the page stays responsive and card events keep arriving throughout. Pass a
   * signal to stop early.
   *
   * ```js
   * await station.setRemote();
   * if (await station.wake({ timeout: 5000 })) {
   *   const info = await station.readInfo();
   * }
   * ```
   *
   * @param {object} [options]
   * @param {number} [options.timeout] total budget in ms, default WAKE_TIMEOUT (30s)
   * @param {number} [options.interval] pause between attempts in ms, default 250
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<boolean>} true if the station answered
   */
  async wake({ timeout = WAKE_TIMEOUT, interval = 250, signal } = {}) {
    const deadline = Date.now() + timeout;
    let attempts = 0;

    while (Date.now() < deadline) {
      if (signal?.aborted) return false;
      attempts += 1;

      // Whatever is left of the budget, but never long enough to overshoot it
      // and never so short that a station that is awake cannot answer.
      const remaining = deadline - Date.now();
      const perTry = Math.max(200, Math.min(700, remaining));

      this.dispatchEvent(
        new CustomEvent('waking', {
          detail: { attempts, elapsed: timeout - remaining, timeout },
        })
      );

      try {
        await this.sendCommand(CMD.GET_TIME, [], { timeout: perTry, retries: 0 });
        this.dispatchEvent(
          new CustomEvent('wake', { detail: { attempts, elapsed: timeout - remaining } })
        );
        return true;
      } catch (err) {
        // A station that is merely asleep answers with a NAK, or not at all.
        // Anything else means the link itself is broken, so stop.
        if (!(err instanceof SINakError) && !(err instanceof SITimeoutError)) throw err;
      }

      const pause = Math.min(interval, deadline - Date.now());
      if (pause > 0) await delay(pause, signal);
    }

    return false;
  }

  /** Which station the next command will reach: the cabled one or the one on top. */
  get target() {
    return this.direct ? 'direct' : 'remote';
  }

  /**
   * @param {'direct'|'remote'} target
   */
  async setTarget(target) {
    if (target === 'direct') return this.setDirect();
    if (target === 'remote') return this.setRemote();
    throw new SIProtocolError(`Unknown target "${target}". Use 'direct' or 'remote'.`);
  }

  /**
   * Run something against the station standing on the coupling stick, then go
   * back to the cabled one whatever happens.
   *
   * Leaving a session in remote mode is the easy mistake here: every later
   * command silently goes to the wrong station, and a `powerOff()` or
   * `eraseBackup()` meant for the one on the cable lands on the other. The
   * restore runs in a finally block for that reason.
   *
   * ```js
   * const info = await station.withRemote(() => station.readInfo());
   * ```
   *
   * A station on the stick is usually asleep, so by default this spends up to
   * thirty seconds waking it before running `fn` -- a real cold wake was
   * measured at 22.8 seconds. Pass `wake: false` to skip that, or a number to
   * change the budget. Listen for `waking` events to show progress.
   *
   * @template T
   * @param {(station: this) => Promise<T>} fn
   * @param {object} [options]
   * @param {boolean|number} [options.wake] wake budget in ms, or false
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<T>}
   */
  async withRemote(fn, { wake = WAKE_TIMEOUT, signal } = {}) {
    const wasDirect = this.direct;
    if (wasDirect) await this.setRemote();

    if (wake !== false) {
      const timeout = wake === true ? WAKE_TIMEOUT : wake;
      const awake = await this.wake({ timeout, signal });
      if (!awake) {
        // Put the session back before reporting, so a caller that catches this
        // is not left talking to the wrong station.
        if (wasDirect) await this.setDirect().catch(() => {});
        throw new SITimeoutError(
          `The remote station did not answer within ${timeout} ms. It may be asleep, ` +
            'out of contact with the coupling stick, or flat.'
        );
      }
    }

    let result;
    let failure = null;
    try {
      result = await fn(this);
    } catch (err) {
      failure = err;
    }

    if (wasDirect) {
      try {
        await this.setDirect();
      } catch (err) {
        // Being stuck in remote mode is worse than whatever went wrong inside
        // fn, because every later command quietly goes to the wrong station.
        // Always announce it, and let it through if nothing else failed.
        this.dispatchEvent(new CustomEvent('error', { detail: { error: err } }));
        if (!failure) throw err;
      }
    }

    if (failure) throw failure;
    return result;
  }

  /** @param {boolean} [extended] */
  async setExtendedProtocol(extended = true) {
    await this.#writeProtoConfig({ extendedProtocol: extended });
  }

  /** Turn autosend on or off. Handshake is set to the opposite, as it must be. */
  async setAutoSend(autoSend = true) {
    await this.#writeProtoConfig({ autoSend, handshake: !autoSend });
  }

  async #writeProtoConfig(changes) {
    await this.#sysvalOrRefresh();
    const config = { ...this.protoConfig, ...changes };
    const byte =
      ((config.extendedProtocol ? 1 : 0) << 0) |
      ((config.autoSend ? 1 : 0) << 1) |
      ((config.handshake ? 1 : 0) << 2) |
      ((config.passwordAccess ? 1 : 0) << 4) |
      ((config.readCardAfterPunch ? 1 : 0) << 7);
    try {
      await this.sendCommand(CMD.SET_SYS_VAL, [O.PROTO, byte]);
    } finally {
      await this.refreshSysval();
    }
  }

  /**
   * @param {number|string} mode one of MODE.CONTROL, START, FINISH, READOUT,
   *   CLEAR, CHECK, or the same thing by name: 'start', 'check', 'finish',
   *   'readout', 'clear', 'control'
   */
  async setOperatingMode(mode) {
    const value = typeof mode === 'string' ? MODE_BY_NAME[mode.trim().toLowerCase()] : mode;

    if (value === undefined) {
      throw new SIProtocolError(
        `Unknown mode "${mode}". Use one of: ${Object.keys(MODE_BY_NAME).join(', ')}.`
      );
    }
    const beacon = BEACON_MODES.includes(value);
    if (!SUPPORTED_MODES.includes(value) && !beacon) {
      throw new SIProtocolError(
        `Cannot set mode 0x${value.toString(16)}. Supported modes are control, start, finish, readout, clear and check, plus the beacon modes.`
      );
    }

    try {
      if (beacon) return await this.#setBeaconMode(value);
      await this.sendCommand(CMD.SET_SYS_VAL, [O.MODE, value]);
      return value;
    } finally {
      await this.refreshSysval();
    }
  }

  /**
   * Write a beacon mode, coping with both generations of station.
   *
   * Older Air+ stations take 0x12 to 0x15. Newer ones (BSF9 and later, and some
   * BSF8s) want those same modes 0x20 higher and answer the old form with a
   * NAK. There is no capability bit to read, so the only way to tell is to try:
   * old form first, new form if that is refused.
   *
   * @returns {Promise<number>} the byte the station actually accepted
   */
  async #setBeaconMode(mode) {
    const alternative = BEACON_OLD_TO_NEW[mode];
    try {
      await this.sendCommand(CMD.SET_SYS_VAL, [O.MODE, mode]);
      return mode;
    } catch (err) {
      // Only a refusal is worth a second attempt. A connection failure is not.
      const refused = err instanceof SINakError || err instanceof SITimeoutError;
      if (!refused || alternative === undefined) throw err;

      try {
        await this.sendCommand(CMD.SET_SYS_VAL, [O.MODE, alternative]);
        return alternative;
      } catch (second) {
        if (!(second instanceof SINakError) && !(second instanceof SITimeoutError)) throw second;
        // Neither encoding was accepted, so this is not a beacon-capable
        // station rather than a station of the other generation.
        throw new SIProtocolError(
          `This station refused beacon mode in both encodings (0x${mode.toString(16)} and ` +
            `0x${alternative.toString(16)}). Touch-free punching needs an Air+ capable ` +
            'station such as a BSF8 with recent firmware, BSF9 or BS11.',
          { cause: second }
        );
      }
    }
  }

  /**
   * Write the mode byte with no questions asked.
   *
   * `setOperatingMode()` only accepts modes this library knows, which is the
   * right default but blocks the ones nobody has written down. The SIAC
   * special modes are the live example: SPORTident documents four of them --
   * SIAC ON, SIAC OFF, Radio Readout and Battery Test -- and says the code
   * number does not apply to them, so each must be its own mode byte, but
   * publishes no values. sireader2.py knows only 0x01, vaguely, as "SIAC
   * special (ON, OFF, Radio_ReadOut, etc.)".
   *
   * The way to find one is to read it off a station that Config+ has already
   * set, then write that byte here.
   *
   * @param {number} byte 0 to 255
   * @returns {Promise<number>} the byte the station reports afterwards, which
   *   is not always the byte you sent
   */
  async setModeByte(byte) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new SIProtocolError(`A mode byte is 0 to 255, got ${byte}`);
    }
    try {
      await this.sendCommand(CMD.SET_SYS_VAL, [O.MODE, byte]);
    } finally {
      await this.refreshSysval();
    }
    return this.mode;
  }

  /**
   * Put the station into one of the SIAC special functions.
   *
   * These are not four modes. The station goes into MODE.SIAC_SPECIAL and the
   * control code picks the function, so both bytes have to be written -- set
   * the mode alone and you get whichever function the old code happens to
   * name. Config+ hides the code field in these modes for the same reason.
   *
   * @param {'on'|'off'|'battery-test'|'radio-readout'} name
   * @returns {Promise<{mode: number, code: number, name: string}>}
   */
  async setSiacFunction(name) {
    const wanted = siacFunctionByKey(String(name).trim().toLowerCase());
    if (!wanted) {
      throw new SIProtocolError(
        `Unknown SIAC function "${name}". Use one of: ` +
          `${SIAC_FUNCTIONS.map((f) => f.key).join(', ')}.`
      );
    }

    // Code first: while it is being written the station is still in its old
    // mode, so a half-done change leaves something harmless rather than a
    // SIAC station performing the wrong function.
    await this.setStationCode(wanted.code);
    await this.setModeByte(wanted.mode);

    return { mode: this.mode, code: wanted.code, name: wanted.name };
  }

  /**
   * Which SIAC special function this station performs, or null when it is not
   * in that mode at all.
   */
  get siacFunction() {
    const mode = this.mode;
    if (mode === null || !SIAC_MODES.includes(mode) || !this.protoConfig) return null;
    const code = this.#field(O.STATION_CODE, 1)[0] | ((this.#field(O.FEEDBACK, 1)[0] >> 6) << 8);
    return siacFunctionFor(mode, code)?.name ?? null;
  }

  /** The mode the station is in right now, as a number. */
  get mode() {
    return this.protoConfig?.mode ?? null;
  }

  /** The mode the station is in right now, as a word. */
  get modeName() {
    return this.protoConfig?.modeName ?? null;
  }

  /** Shorthands, so a UI does not have to carry the MODE table around. */
  async setStartMode() {
    return this.setOperatingMode(MODE.START);
  }
  async setCheckMode() {
    return this.setOperatingMode(MODE.CHECK);
  }
  async setFinishMode() {
    return this.setOperatingMode(MODE.FINISH);
  }
  async setReadoutMode() {
    return this.setOperatingMode(MODE.READOUT);
  }
  async setClearMode() {
    return this.setOperatingMode(MODE.CLEAR);
  }
  async setControlMode() {
    return this.setOperatingMode(MODE.CONTROL);
  }

  /**
   * Set the control code, 1 to 1023.
   *
   * The two high bits live in the feedback byte, so writing a code means
   * writing that byte too. By default the beeper and lamp settings already on
   * the station are kept; the Python original switches both on as a side
   * effect, which you can reproduce with `preserveFeedback: false`.
   */
  async setStationCode(code, { preserveFeedback = true } = {}) {
    if (!Number.isInteger(code) || code < 1 || code > 1023) {
      throw new SIProtocolError(`Control code must be between 1 and 1023, got ${code}`);
    }
    await this.#sysvalOrRefresh();
    const low = code & 0xff;
    const highBits = (code >> 8) << 6;
    const feedback = preserveFeedback
      ? (this.#field(O.FEEDBACK, 1)[0] & 0b00111111) | highBits
      : highBits | 0b00111111;
    try {
      await this.sendCommand(CMD.SET_SYS_VAL, [O.STATION_CODE, low, feedback]);
    } finally {
      await this.refreshSysval();
    }
  }

  /** Beeper and lamp on punch. */
  async setFeedback({ audible = true, optical = true } = {}) {
    await this.#sysvalOrRefresh();
    let feedback = this.#field(O.FEEDBACK, 1)[0];
    feedback = optical ? feedback | 0b1 : feedback & ~0b1;
    feedback = audible ? feedback | 0b100 : feedback & ~0b100;
    await this.sendCommand(CMD.SET_SYS_VAL, [O.FEEDBACK, feedback & 0xff]);
    await this.refreshSysval();
  }

  /** How long the station stays awake after the last punch, in minutes. */
  async setActiveTime(minutes) {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 5759) {
      throw new SIProtocolError(
        `Active time must be between 0 and 5759 minutes, got ${minutes}`
      );
    }
    await this.sendCommand(CMD.SET_SYS_VAL, concat([O.ACTIVE_TIME], toBytes(minutes, 2)));
    await this.refreshSysval();
  }

  /** Whether SI-Card 6 is read with all eight blocks (192 punches). */
  async setSi6With192Punches(enable = false) {
    await this.sendCommand(CMD.SET_SYS_VAL, [O.SI6_CB, enable ? 0xff : 0xc1]);
    await this.refreshSysval();
  }

  /** Switch the station to 4800 baud. The port follows. */
  async setBaudRateLow() {
    await this.sendCommand(CMD.SET_BAUD, [0x00]);
    if (this.direct) await this.#transport.setBaudRate(BAUD_LOW);
  }

  /** Switch the station to 38400 baud. The port follows. */
  async setBaudRateHigh() {
    await this.sendCommand(CMD.SET_BAUD, [0x01]);
    if (this.direct) await this.#transport.setBaudRate(BAUD_HIGH);
  }

  // -------------------------------------------------------------------- clock

  /** Read the station clock. Returns null if the station reports a bad date. */
  async getTime() {
    const t = await this.sendCommand(CMD.GET_TIME, []);
    const year = t[0] + 2000;
    const month = t[1];
    const day = t[2];
    const pm = t[3] & 0b1;
    let seconds = toInt(t.subarray(4, 6));
    const hour = pm * 12 + Math.floor(seconds / 3600);
    seconds %= 3600;
    const minute = Math.floor(seconds / 60);
    const second = seconds % 60;
    const ms = Math.round((t[6] / 256) * 1000);

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(year, month - 1, day, hour, minute, second, ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  /** Set the station clock. Defaults to the computer clock. */
  async setTime(time = new Date()) {
    const bintime = concat(
      [time.getFullYear() % 100, time.getMonth() + 1, time.getDate()],
      [(time.getDay() << 1) + (time.getHours() >= 12 ? 1 : 0)],
      toBytes(
        (time.getHours() % 12) * 3600 + time.getMinutes() * 60 + time.getSeconds(),
        2
      ),
      [Math.min(255, Math.round((time.getMilliseconds() / 1000) * 256))]
    );
    await this.sendCommand(CMD.SET_TIME, bintime);
  }

  /** Difference between the station clock and this computer, in milliseconds. */
  async getClockOffset() {
    const before = Date.now();
    const stationTime = await this.getTime();
    const after = Date.now();
    if (!stationTime) return null;
    return stationTime.getTime() - (before + after) / 2;
  }

  // ------------------------------------------------------------------ actions

  /** Beep and blink, even with no card in the station. */
  async beep(count = 1) {
    await this.sendCommand(CMD.BEEP, [count]);
  }

  /** Wipe the backup memory. There is no undo. */
  async eraseBackup() {
    await this.sendCommand(CMD.ERASE_BACKUP, []);
  }

  /** Switch the station off. */
  async powerOff() {
    await this.sendCommand(CMD.OFF, []);
  }

  /**
   * Switch off a remote station. This is the odd byte sequence Config+ uses;
   * it is not a normal command frame and there is no reply.
   */
  async powerOffRemote() {
    await this.sendRaw(REMOTE_OFF);
  }

  // ------------------------------------------------------------ backup memory

  /**
   * Read the whole backup memory of a station in control, check, clear, start
   * or finish mode.
   *
   * Set direct or remote mode first, depending on which station you mean. The
   * cabled station must be in extended protocol mode; the remote station may be
   * in either.
   *
   * @param {object} [options]
   * @param {(done: number, total: number) => void} [options.onProgress]
   * @param {Date} [options.now] reference time for legacy records
   * @returns {Promise<import('./protocol.js').SIBackupPunch[]>}
   */
  async readBackup({ onProgress, now = new Date() } = {}) {
    await this.refreshSysval();
    if (!SUPPORTED_READ_BACKUP_MODES.includes(this.protoConfig.mode)) {
      throw new SIProtocolError(
        `Cannot read backup memory from a station in ${this.protoConfig.modeName} mode`
      );
    }

    const sysval = this.sysval;
    const hi = extractSysval(sysval, O.BACKUP_PTR_HI, 2);
    const lo = extractSysval(sysval, O.BACKUP_PTR_LO, 2);
    const endPointer = toInt(concat(hi, lo));

    const extended = this.protoConfig.extendedProtocol;
    const first = extended ? BUX.FIRST : BUL.FIRST;

    const chunks = [];
    let readPointer = 0x100; // reading always seems to start here
    const total = Math.max(endPointer - readPointer, 0);

    while (readPointer < endPointer) {
      const count = Math.min(0x80, endPointer - readPointer);
      const data = await this.sendCommand(
        CMD.GET_BACKUP,
        concat(toBytes(readPointer, 3), [count])
      );
      chunks.push(data.subarray(first + 1));
      readPointer += count;
      onProgress?.(readPointer - 0x100, total);
    }

    const memory = concat(...chunks);
    return extended ? decodeBackupExtended(memory) : decodeBackupLegacy(memory, now);
  }

  /** Read one record from the backup memory at a byte offset. */
  async readBackupRecord(offset, length = 8) {
    const data = await this.sendCommand(
      CMD.GET_BACKUP,
      concat(toBytes(offset, 3), [length])
    );
    return data;
  }
}

// --------------------------------------------------------------------- helpers

function formatSysvalDate(bytes) {
  const pad = (n) => String(n).padStart(2, '0');
  return `20${pad(bytes[0])}-${pad(bytes[1])}-${pad(bytes[2])}`;
}

/** Decode the punch record in an autosend frame. */
export function decodeAutosendPunch(data, reftime = null) {
  return {
    cardNumber: decodeCardNumber(data.subarray(0, 4)),
    time: decodeTime(data.subarray(5, 7), null, reftime),
    memoryOffset: toInt(data.subarray(8, 11)),
  };
}
