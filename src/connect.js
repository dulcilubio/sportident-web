// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2008-2023 Gaudenz Steinlin, Simon Harston, Jan Vorwerk,
//                         Per Magnusson (sireader2.py)
// Copyright (C) 2026 dulcilubio (JavaScript port)
// See NOTICE and LICENSE at the repository root.

/**
 * Picking a transport.
 *
 * No single browser API reaches a station on every platform, so the choice is
 * made at runtime:
 *
 *   Windows   Web Serial, through the SPORTident USB driver
 *   Linux     Web Serial, through the in-kernel cp210x module
 *   macOS     either -- Web Serial if the Silicon Labs driver is installed,
 *             WebUSB if it is not
 *   Android   WebUSB, since Web Serial does not exist there
 *
 * The rule that decides it is not really "which browser" but "has a kernel
 * driver claimed the device". If one has, it owns the endpoints and WebUSB
 * cannot touch them, so Web Serial is the only way in. If none has, the device
 * never appears as a serial port and WebUSB is the only way in. Preferring Web
 * Serial and falling back to WebUSB therefore covers all four platforms.
 */

import { SIConnectionError } from './errors.js';
import {
  getGrantedPorts,
  isWebSerialSupported,
  requestPort,
  WebSerialTransport,
} from './transport.js';
import {
  getGrantedUsbDevices,
  isWebUsbSupported,
  requestUsbDevice,
  WebUsbTransport,
} from './webusb.js';

/** True if the object already satisfies the transport interface. */
function isTransport(value) {
  return (
    value &&
    typeof value.open === 'function' &&
    typeof value.write === 'function' &&
    typeof value.setBaudRate === 'function'
  );
}

/** True for a WebUSB device rather than a Web Serial port. */
function isUsbDevice(value) {
  return value && typeof value.transferIn === 'function';
}

/**
 * Wrap whatever the caller has into a transport.
 *
 * Accepts a Web Serial port, a WebUSB device, or something that is already a
 * transport, so callers do not have to care which API produced it.
 *
 * @param {SerialPort|USBDevice|object} source
 * @param {import('./transport.js').TransportHandlers} [handlers]
 */
export function toTransport(source, handlers = {}) {
  if (isTransport(source)) return source;
  if (isUsbDevice(source)) return new WebUsbTransport(source, handlers);
  if (source) return new WebSerialTransport(source, handlers);
  throw new SIConnectionError('No port or device was given');
}

/**
 * What this browser can do. Useful for showing the right button.
 *
 * @returns {{webSerial: boolean, webUsb: boolean, any: boolean}}
 */
export function transportSupport() {
  const webSerial = isWebSerialSupported();
  const webUsb = isWebUsbSupported();
  return { webSerial, webUsb, any: webSerial || webUsb };
}

/**
 * Ask the user for a station, using whichever API can reach one.
 *
 * Must be called from a user gesture such as a click, because both underlying
 * pickers require one.
 *
 * On a desktop with the driver installed the Web Serial picker opens and that
 * is the end of it. If the user's machine has no driver the serial picker has
 * nothing to list, so this falls back to the WebUSB picker, which is also the
 * only picker Android has.
 *
 * @param {object} [options]
 * @param {'auto'|'serial'|'usb'} [options.prefer] force one API, default 'auto'
 * @param {boolean} [options.anyPort] drop the SPORTident USB id filter
 * @returns {Promise<SerialPort|USBDevice>}
 */
export async function requestStation({ prefer = 'auto', anyPort = false } = {}) {
  const { webSerial, webUsb } = transportSupport();

  if (prefer === 'serial') {
    if (!webSerial) throw new SIConnectionError('This browser does not support Web Serial.');
    return requestPort({ anyPort });
  }
  if (prefer === 'usb') {
    if (!webUsb) throw new SIConnectionError('This browser does not support WebUSB.');
    return requestUsbDevice({ anyDevice: anyPort });
  }

  if (!webSerial && !webUsb) {
    throw new SIConnectionError(
      'This browser can reach a station through neither Web Serial nor WebUSB. ' +
        'Chrome or Edge is needed; on iOS neither API exists in any browser.'
    );
  }

  if (webSerial) {
    try {
      return await requestPort({ anyPort });
    } catch (err) {
      // NotFoundError means the picker had nothing to show or the user
      // dismissed it. On a machine with no driver the station is invisible to
      // Web Serial but still reachable over WebUSB, so it is worth a second
      // ask before giving up.
      if (err?.name !== 'NotFoundError' || !webUsb) throw err;
    }
  }

  return requestUsbDevice({ anyDevice: anyPort });
}

/**
 * Everything the user has already granted access to, from both APIs, ready to
 * reopen without a click.
 *
 * @returns {Promise<Array<SerialPort|USBDevice>>}
 */
export async function getGrantedStations() {
  const [ports, devices] = await Promise.all([getGrantedPorts(), getGrantedUsbDevices()]);
  return [...ports, ...devices];
}
