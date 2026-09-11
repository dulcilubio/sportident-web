// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2008-2023 Gaudenz Steinlin, Simon Harston, Jan Vorwerk,
//                         Per Magnusson (sireader2.py)
// Copyright (C) 2026 dulcilubio (JavaScript port)
// See NOTICE and LICENSE at the repository root.

/**
 * Serial transport layer.
 *
 * The read loop runs continuously and pushes bytes to a callback. Nothing here
 * ever blocks waiting for a reply; matching replies to commands is the job of
 * the layer above.
 */

import { SIConnectionError } from './errors.js';
import { BAUD_HIGH, USB_FILTERS } from './constants.js';

/** True if this browser exposes the Web Serial API. */
export function isWebSerialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/**
 * Ask the user to pick a serial port. Must be called from a user gesture such
 * as a click, otherwise the browser will reject it.
 *
 * @param {object} [options]
 * @param {boolean} [options.anyPort] show every port rather than only the USB
 *   identifiers known to be used by SPORTident hardware
 * @returns {Promise<SerialPort>}
 */
export async function requestPort({ anyPort = false } = {}) {
  if (!isWebSerialSupported()) {
    throw new SIConnectionError(
      'This browser does not support Web Serial. Chrome, Edge and Opera on desktop do.'
    );
  }
  return navigator.serial.requestPort(anyPort ? {} : { filters: USB_FILTERS });
}

/** Ports the user has already granted access to, ready to reopen. */
export async function getGrantedPorts() {
  if (!isWebSerialSupported()) return [];
  return navigator.serial.getPorts();
}

/**
 * @typedef {object} TransportHandlers
 * @property {(chunk: Uint8Array) => void} [onData]
 * @property {(error: Error) => void} [onError]
 * @property {() => void} [onClose]
 */

export class WebSerialTransport {
  #port = null;
  #reader = null;
  #writer = null;
  #closing = false;
  #loop = null;

  /**
   * @param {SerialPort} port a port from requestPort() or getGrantedPorts()
   * @param {TransportHandlers} [handlers]
   */
  constructor(port, handlers = {}) {
    this.#port = port;
    this.onData = handlers.onData ?? (() => {});
    this.onError = handlers.onError ?? (() => {});
    this.onClose = handlers.onClose ?? (() => {});
    this.baudRate = BAUD_HIGH;
  }

  get isOpen() {
    return this.#writer !== null;
  }

  get port() {
    return this.#port;
  }

  /**
   * Open the port and start reading.
   * @param {object} [options]
   * @param {number} [options.baudRate]
   * @param {boolean} [options.dataTerminalReady] most USB serial bridges want this
   * @param {boolean} [options.requestToSend]
   */
  async open({
    baudRate = BAUD_HIGH,
    dataTerminalReady = true,
    requestToSend = true,
  } = {}) {
    if (this.isOpen) throw new SIConnectionError('The port is already open');
    this.#closing = false;
    this.baudRate = baudRate;

    try {
      await this.#port.open({
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: 4096,
      });
    } catch (err) {
      if (err?.name === 'InvalidStateError') {
        // Already open from an earlier session in this page. Carry on.
      } else {
        throw new SIConnectionError(`Could not open the port: ${err.message}`, {
          cause: err,
        });
      }
    }

    try {
      await this.#port.setSignals({ dataTerminalReady, requestToSend });
    } catch {
      // Not every driver supports setting the control lines. Not fatal.
    }

    this.#writer = this.#port.writable.getWriter();
    this.#loop = this.#readLoop();
  }

  async #readLoop() {
    while (this.#port?.readable && !this.#closing) {
      let reader;
      try {
        reader = this.#port.readable.getReader();
      } catch (err) {
        this.onError(new SIConnectionError(`Could not read from the port: ${err.message}`));
        break;
      }
      this.#reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) this.onData(value);
        }
      } catch (err) {
        if (!this.#closing) {
          this.onError(
            new SIConnectionError(`Lost the connection to the station: ${err.message}`, {
              cause: err,
            })
          );
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
        this.#reader = null;
      }
    }
  }

  /** @param {Uint8Array} bytes */
  async write(bytes) {
    if (!this.#writer) throw new SIConnectionError('The port is not open');
    try {
      await this.#writer.write(bytes);
    } catch (err) {
      throw new SIConnectionError(`Could not send to the station: ${err.message}`, {
        cause: err,
      });
    }
  }

  /**
   * Change the line speed. Web Serial can only do this by closing and
   * reopening, so the port drops for a moment.
   * @param {number} baudRate
   */
  async setBaudRate(baudRate) {
    if (baudRate === this.baudRate && this.isOpen) return;
    const wasOpen = this.isOpen;
    if (wasOpen) await this.close({ keepPort: true });
    await this.open({ baudRate });
  }

  /** Stop reading and release the port. */
  async close({ keepPort = false } = {}) {
    this.#closing = true;

    if (this.#reader) {
      try {
        await this.#reader.cancel();
      } catch {
        /* already gone */
      }
    }
    if (this.#loop) {
      try {
        await this.#loop;
      } catch {
        /* the loop reports its own errors */
      }
      this.#loop = null;
    }
    if (this.#writer) {
      try {
        this.#writer.releaseLock();
      } catch {
        /* already released */
      }
      this.#writer = null;
    }
    try {
      await this.#port.close();
    } catch {
      /* already closed */
    }
    if (!keepPort) this.onClose();
  }
}
