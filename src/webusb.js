// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2008-2023 Gaudenz Steinlin, Simon Harston, Jan Vorwerk,
//                         Per Magnusson (sireader2.py)
// Copyright (C) 2026 dulcilubio (JavaScript port)
// See NOTICE and LICENSE at the repository root.

/**
 * WebUSB transport: drives the CP210x USB-to-UART bridge directly.
 *
 * Web Serial is desktop only, so Android has no way to reach a station through
 * it. WebUSB is available there, but it hands us a raw USB device rather than a
 * serial port, so the part the operating system's driver would normally do --
 * enabling the UART, setting the line speed and framing -- has to happen here
 * as vendor control transfers. Payload bytes then move over the bulk endpoints.
 *
 * This only works when no kernel driver has claimed the interface:
 *
 * - Android: nothing claims it, so this is the way in.
 * - macOS: Apple's AppleUSBSLCOM driver only binds to the stock Silicon Labs
 *   product ids (0xEA60, 0xEA70). SPORTident ships 0x800A, so the interface is
 *   free and this works with no driver installed at all.
 * - Windows and Linux: the vendor driver or the cp210x kernel module usually
 *   claims the device first, which blocks WebUSB. Prefer WebSerialTransport
 *   there.
 *
 * The interface matches WebSerialTransport, so everything above the transport
 * is unchanged.
 */

import { SIConnectionError } from './errors.js';
import { BAUD_HIGH, USB_FILTERS } from './constants.js';

/**
 * CP210x vendor requests, from the Silicon Labs AN571 interface specification.
 * Sent to the interface, not the device, so the recipient is 'interface'.
 */
const CP210X = {
  IFC_ENABLE: 0x00,
  SET_LINE_CTL: 0x03,
  SET_MHS: 0x07,
  SET_BAUDRATE: 0x1e,
  PURGE: 0x12,
};

const UART_ENABLE = 0x0001;
const UART_DISABLE = 0x0000;

/** 8 data bits, no parity, 1 stop bit: the framing every SPORTident station uses. */
const LINE_CTL_8N1 = 0x0800;

/** DTR and RTS asserted, with the matching write mask in the high byte. */
const MHS_DTR_RTS_ON = 0x0303;

/** Flush both directions. */
const PURGE_ALL = 0x000f;

/** True if this browser exposes WebUSB. */
export function isWebUsbSupported() {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

/**
 * Ask the user to pick a USB device. Must be called from a user gesture.
 *
 * @param {object} [options]
 * @param {boolean} [options.anyDevice] show every device rather than only the
 *   USB identifiers known to be used by SPORTident hardware
 * @returns {Promise<USBDevice>}
 */
export async function requestUsbDevice({ anyDevice = false } = {}) {
  if (!isWebUsbSupported()) {
    throw new SIConnectionError(
      'This browser does not support WebUSB. Chrome and Edge do, on desktop and Android.'
    );
  }
  return navigator.usb.requestDevice({
    filters: anyDevice ? [{}] : USB_FILTERS,
  });
}

/** Devices the user has already granted access to, ready to reopen. */
export async function getGrantedUsbDevices() {
  if (!isWebUsbSupported()) return [];
  return navigator.usb.getDevices();
}

export class WebUsbTransport {
  #device = null;
  #interfaceNumber = 0;
  #inEndpoint = 0;
  #outEndpoint = 0;
  #packetSize = 64;
  #open = false;
  #closing = false;
  #loop = null;

  /**
   * @param {USBDevice} device a device from requestUsbDevice() or getGrantedUsbDevices()
   * @param {import('./transport.js').TransportHandlers} [handlers]
   */
  constructor(device, handlers = {}) {
    this.#device = device;
    this.onData = handlers.onData ?? (() => {});
    this.onError = handlers.onError ?? (() => {});
    this.onClose = handlers.onClose ?? (() => {});
    this.baudRate = BAUD_HIGH;
  }

  get isOpen() {
    return this.#open;
  }

  get device() {
    return this.#device;
  }

  /**
   * Open the device, configure the bridge and start reading.
   * @param {object} [options]
   * @param {number} [options.baudRate]
   */
  async open({ baudRate = BAUD_HIGH } = {}) {
    if (this.#open) throw new SIConnectionError('The device is already open');
    this.#closing = false;
    this.baudRate = baudRate;

    try {
      if (!this.#device.opened) await this.#device.open();
      if (this.#device.configuration === null) {
        await this.#device.selectConfiguration(1);
      }
      this.#findEndpoints();
      await this.#device.claimInterface(this.#interfaceNumber);
    } catch (err) {
      throw new SIConnectionError(
        `Could not open the USB device: ${err.message}. On Windows and Linux a ` +
          'kernel driver usually owns the port already, which blocks WebUSB; use ' +
          'WebSerialTransport there.',
        { cause: err }
      );
    }

    try {
      await this.#vendorWrite(CP210X.IFC_ENABLE, UART_ENABLE);
      await this.#setBaudRateOnDevice(baudRate);
      await this.#vendorWrite(CP210X.SET_LINE_CTL, LINE_CTL_8N1);
      await this.#vendorWrite(CP210X.SET_MHS, MHS_DTR_RTS_ON);
      await this.#vendorWrite(CP210X.PURGE, PURGE_ALL);
    } catch (err) {
      throw new SIConnectionError(`Could not configure the bridge: ${err.message}`, {
        cause: err,
      });
    }

    this.#open = true;
    this.#loop = this.#readLoop();
  }

  /**
   * Pick the bulk endpoints. The CP210x exposes a single vendor-specific
   * interface with one bulk pair.
   */
  #findEndpoints() {
    const iface =
      this.#device.configuration.interfaces.find((i) =>
        i.alternate.endpoints.some((e) => e.type === 'bulk')
      ) ?? this.#device.configuration.interfaces[0];

    if (!iface) throw new Error('the device exposes no usable interface');

    this.#interfaceNumber = iface.interfaceNumber;
    const endpoints = iface.alternate.endpoints;
    const input = endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
    const output = endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');

    if (!input || !output) throw new Error('the device exposes no bulk endpoint pair');

    this.#inEndpoint = input.endpointNumber;
    this.#outEndpoint = output.endpointNumber;
    this.#packetSize = input.packetSize || 64;
  }

  /**
   * A vendor request whose argument travels in wValue, with no data stage.
   * @param {number} request
   * @param {number} value
   */
  async #vendorWrite(request, value) {
    const result = await this.#device.controlTransferOut({
      requestType: 'vendor',
      recipient: 'interface',
      request,
      value,
      index: this.#interfaceNumber,
    });
    if (result.status !== 'ok') {
      throw new Error(`vendor request 0x${request.toString(16)} was ${result.status}`);
    }
  }

  /**
   * SET_BAUDRATE carries the rate as a little-endian 32-bit value in the data
   * stage rather than in wValue, unlike the other requests here.
   * @param {number} baudRate
   */
  async #setBaudRateOnDevice(baudRate) {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, baudRate, true);
    const result = await this.#device.controlTransferOut(
      {
        requestType: 'vendor',
        recipient: 'interface',
        request: CP210X.SET_BAUDRATE,
        value: 0,
        index: this.#interfaceNumber,
      },
      payload
    );
    if (result.status !== 'ok') {
      throw new Error(`could not set ${baudRate} baud: ${result.status}`);
    }
  }

  async #readLoop() {
    while (this.#open && !this.#closing) {
      let result;
      try {
        result = await this.#device.transferIn(this.#inEndpoint, this.#packetSize);
      } catch (err) {
        if (!this.#closing) {
          this.onError(
            new SIConnectionError(`Lost the connection to the station: ${err.message}`, {
              cause: err,
            })
          );
        }
        break;
      }

      if (result.status === 'stall') {
        try {
          await this.#device.clearHalt('in', this.#inEndpoint);
          continue;
        } catch (err) {
          if (!this.#closing) {
            this.onError(
              new SIConnectionError(`The read endpoint stalled: ${err.message}`, { cause: err })
            );
          }
          break;
        }
      }

      const data = result.data;
      if (data && data.byteLength) {
        this.onData(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
    }
  }

  /** @param {Uint8Array} bytes */
  async write(bytes) {
    if (!this.#open) throw new SIConnectionError('The device is not open');
    try {
      const result = await this.#device.transferOut(this.#outEndpoint, bytes);
      if (result.status !== 'ok') {
        throw new Error(`the write was ${result.status}`);
      }
    } catch (err) {
      throw new SIConnectionError(`Could not send to the station: ${err.message}`, {
        cause: err,
      });
    }
  }

  /**
   * Change the line speed. Unlike Web Serial this is a single control transfer,
   * so the connection stays up and no bytes are lost.
   * @param {number} baudRate
   */
  async setBaudRate(baudRate) {
    if (baudRate === this.baudRate && this.#open) return;
    this.baudRate = baudRate;
    if (!this.#open) return;
    try {
      await this.#setBaudRateOnDevice(baudRate);
    } catch (err) {
      throw new SIConnectionError(`Could not change the line speed: ${err.message}`, {
        cause: err,
      });
    }
  }

  /**
   * Stop reading and release the device.
   *
   * Order matters here. WebUSB has no equivalent of cancelling a stream
   * reader, so the read loop is parked inside transferIn() with nothing to
   * wake it. Releasing the interface is what makes that pending transfer
   * reject, so the device has to be let go before the loop is awaited --
   * the other way round deadlocks.
   */
  async close({ keepPort = false } = {}) {
    this.#closing = true;
    this.#open = false;

    // Still holding the interface, so this is the last chance to park the UART.
    try {
      await this.#vendorWrite(CP210X.IFC_ENABLE, UART_DISABLE);
    } catch {
      /* the device may already be gone */
    }
    try {
      await this.#device.releaseInterface(this.#interfaceNumber);
    } catch {
      /* already released */
    }
    try {
      await this.#device.close();
    } catch {
      /* already closed */
    }

    if (this.#loop) {
      try {
        await this.#loop;
      } catch {
        /* the loop reports its own errors */
      }
      this.#loop = null;
    }

    if (!keepPort) this.onClose();
  }
}
