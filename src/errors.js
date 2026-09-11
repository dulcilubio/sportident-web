// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2008-2023 Gaudenz Steinlin, Simon Harston, Jan Vorwerk,
//                         Per Magnusson (sireader2.py)
// Copyright (C) 2026 dulcilubio (JavaScript port)
// See NOTICE and LICENSE at the repository root.

/** Error types thrown by the library. All extend SIError. */

export class SIError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SIError';
  }
}

/** No reply arrived within the timeout. Usually a sleeping or absent station. */
export class SITimeoutError extends SIError {
  constructor(message = 'The station did not reply in time') {
    super(message);
    this.name = 'SITimeoutError';
  }
}

/** A frame arrived but was malformed, or the station refused the command. */
export class SIProtocolError extends SIError {
  constructor(message) {
    super(message);
    this.name = 'SIProtocolError';
  }
}

/** The station answered NAK: unknown command or bad parameters. */
export class SINakError extends SIProtocolError {
  constructor(message = 'The station rejected the command') {
    super(message);
    this.name = 'SINakError';
  }
}

/** A card was inserted or removed while a command was in flight. */
export class SICardChangedError extends SIError {
  constructor(message = 'The card changed during the command') {
    super(message);
    this.name = 'SICardChangedError';
  }
}

/** The serial port is not open, or was lost. */
export class SIConnectionError extends SIError {
  constructor(message) {
    super(message);
    this.name = 'SIConnectionError';
  }
}
