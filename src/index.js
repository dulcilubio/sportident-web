// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2008-2023 Gaudenz Steinlin, Simon Harston, Jan Vorwerk,
//                         Per Magnusson (sireader2.py)
// Copyright (C) 2026 dulcilubio (JavaScript port)
// See NOTICE and LICENSE at the repository root.

/**
 * sportident-web: talk to SPORTident stations from the browser over Web Serial.
 *
 * Ported from sireader2.py (Per Magnusson), itself derived from sireader.py
 * (Gaudenz Steinlin, Simon Harston, Jan Vorwerk). GPL-3.0.
 *
 * Quick start:
 *
 * ```js
 * import { requestPort, SIReadout } from './src/index.js';
 *
 * const port = await requestPort();          // needs a click
 * const station = await SIReadout.open(port);
 * station.addEventListener('card', (e) => {
 *   console.log(e.detail.cardNumber, e.detail.punches);
 * });
 * ```
 */

export * from './constants.js';
export * from './errors.js';
export { concat, crc16, crcCheck, fromHex, hex, toBytes, toInt } from './bytes.js';
export { buildCommand, FrameParser } from './framer.js';
export {
  addDays,
  atSecondsOfDay,
  cardTypeFromDetect,
  cardTypeFromNumber,
  decodeBackupExtended,
  decodeBackupLegacy,
  decodeCardData,
  decodeCardNumber,
  decodeStationCode,
  decodeTime,
  extractSysval,
  secondsSinceMidnight,
  startOfDay,
  weekdayMondayFirst,
} from './protocol.js';
export {
  getGrantedPorts,
  isWebSerialSupported,
  requestPort,
  WebSerialTransport,
} from './transport.js';
export {
  getGrantedUsbDevices,
  isWebUsbSupported,
  requestUsbDevice,
  WebUsbTransport,
} from './webusb.js';
export {
  getGrantedStations,
  requestStation,
  toTransport,
  transportSupport,
} from './connect.js';
export { decodeAutosendPunch, SIStation } from './station.js';
export { SIReadout } from './readout.js';
export { SIControl } from './control.js';
export { SimulatedTransport } from './simulator.js';
export {
  backupFilename,
  backupToCsv,
  downloadText,
  formatDateTime,
  formatTimeOfDay,
  rowsToCsv,
  STATION_LOG_HEADER,
  stationLogRow,
  sysvalToCsv,
} from './csv.js';
