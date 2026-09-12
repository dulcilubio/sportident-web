// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2008-2023 Gaudenz Steinlin, Simon Harston, Jan Vorwerk,
//                         Per Magnusson (sireader2.py)
// Copyright (C) 2026 dulcilubio (JavaScript port)
// See NOTICE and LICENSE at the repository root.

/**
 * Type declarations for sportident-web.
 * The implementation is plain JavaScript; these exist so editors and
 * TypeScript projects get completion and checking.
 */

/**
 * The parts of a Web Serial port this library touches. A real `SerialPort`
 * matches structurally, so you can pass one straight in whether or not you have
 * `@types/w3c-web-serial` installed.
 */
export interface SISerialPort {
  open(options: {
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: string;
    flowControl?: string;
    bufferSize?: number;
  }): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  setSignals?(signals: {
    dataTerminalReady?: boolean;
    requestToSend?: boolean;
  }): Promise<void>;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}

// ---------------------------------------------------------------- data shapes

export interface SIPunch {
  code: number;
  time: Date;
}

export interface SICardData {
  cardNumber: number;
  cardType: SICardType;
  start: Date | null;
  startCode: number | null;
  finish: Date | null;
  finishCode: number | null;
  check: Date | null;
  checkCode: number | null;
  clear: Date | null;
  clearCode: number | null;
  punchCount: number;
  punches: SIPunch[];
  raw?: Uint8Array;
}

export interface SIBackupPunch {
  time: Date;
  cardNumber: number;
  /** Empty when the record is sound, otherwise "ErrA", "ErrDate" and so on. */
  error: string;
}

export interface SIAutosendPunch {
  cardNumber: number;
  time: Date | null;
  memoryOffset: number;
  recovered?: boolean;
}

export interface SIFrame {
  cmd: number;
  station: number;
  data: Uint8Array;
  raw: Uint8Array;
}

export interface SIProtoConfig {
  extendedProtocol: boolean;
  autoSend: boolean;
  handshake: boolean;
  passwordAccess: boolean;
  readCardAfterPunch: boolean;
  mode: number;
  modeName: string;
}

export interface SIStationInfo {
  serialNumber: number;
  firmware: string;
  modelId: number;
  modelName: string;
  buildDate: string;
  batteryDate: string;
  memorySizeKb: number;
  voltage: number;
  batteryCapacityMah: number;
  batteryUsedPercent: number;
  memoryOverflow: boolean;
  code: number;
  mode: number;
  modeName: string;
  activeTimeMinutes: number;
  activeTime: string;
  protocolByte: number;
  extendedProtocol: boolean;
  autoSend: boolean;
  feedbackByte: number;
  opticalFeedback: boolean;
  audibleFeedback: boolean;
  /** true, false, or the raw byte when it is neither of the known values. */
  si6With192Punches: boolean | number;
}

/** Modes that can be set by name. */
export type SIModeName =
  | 'control'
  | 'start'
  | 'finish'
  | 'readout'
  | 'clear'
  | 'check'
  | 'beacon-control'
  | 'beacon-start'
  | 'beacon-finish'
  | 'beacon-readout';

/** Older beacon mode bytes mapped to the form newer Air+ stations require. */
export declare const BEACON_OLD_TO_NEW: Record<number, number>;
export declare const BEACON_MODES: number[];

/** Whether commands go to the cabled station or one on its coupling stick. */
export type SIStationTarget = 'direct' | 'remote';

export declare const MODE_BY_NAME: Record<SIModeName, number>;

/** SIAC special functions, selected by control code within mode 0x01. */
export type SIACFunctionName = 'on' | 'off' | 'battery-test' | 'radio-readout';
export declare const SIAC_FUNCTION: {
  BATTERY_TEST: number;
  ON: number;
  OFF: number;
  RADIO_READOUT: number;
};
export declare const SIAC_FUNCTION_NAMES: Record<number, string>;
export declare const SIAC_FUNCTION_BY_NAME: Record<SIACFunctionName, number>;

export type SICardType = 'SI5' | 'SI6' | 'SI8' | 'SI9' | 'SI10' | 'pCard';

// -------------------------------------------------------------------- options

export interface SIStationOptions {
  debug?: boolean;
  /** Send a 0xFF wakeup byte before each command. Default true. */
  wakeup?: boolean;
  /** Milliseconds to wait for a reply. Default 2000. */
  timeout?: number;
  /** Extra attempts after a timeout. Default 1. */
  retries?: number;
  /** Fail a command when a card changes mid-flight. Default false. */
  strictCardChanged?: boolean;
}

export interface SIReadoutOptions extends SIStationOptions {
  /** Read and acknowledge cards as they are inserted. Default true. */
  autoRead?: boolean;
  /** Beep after a successful read. Default true. */
  autoAck?: boolean;
  /** Look for a card already in the station when connecting. Default true. */
  detectOnConnect?: boolean;
}

export interface SIControlOptions extends SIStationOptions {
  /** Read missed punches back out of backup memory. Default true. */
  recoverMissedPunches?: boolean;
}

export interface SIConnectOptions extends SIStationOptions {
  baudRate?: number;
  /** Retry at 4800 baud if nothing answers. Default true. */
  tryLowSpeed?: boolean;
  /** Send the direct-mode handshake on connect. Default true. */
  handshake?: boolean;
}

export interface SICommandOptions {
  /** Reply frames to collect. Three for SI-Card 6, five for SI-Card 10. */
  frames?: number;
  responseCmd?: number;
  timeout?: number;
  retries?: number;
  wakeup?: boolean;
}

// ------------------------------------------------------------------ transport

export interface SITransport {
  isOpen: boolean;
  baudRate: number;
  onData: (chunk: Uint8Array) => void;
  onError: (error: Error) => void;
  onClose: () => void;
  open(options?: { baudRate?: number }): Promise<void>;
  close(options?: { keepPort?: boolean }): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  setBaudRate(baudRate: number): Promise<void>;
}

export declare class WebSerialTransport implements SITransport {
  constructor(
    port: SISerialPort,
    handlers?: {
      onData?: (chunk: Uint8Array) => void;
      onError?: (error: Error) => void;
      onClose?: () => void;
    }
  );
  readonly isOpen: boolean;
  readonly port: SISerialPort;
  baudRate: number;
  onData: (chunk: Uint8Array) => void;
  onError: (error: Error) => void;
  onClose: () => void;
  open(options?: {
    baudRate?: number;
    dataTerminalReady?: boolean;
    requestToSend?: boolean;
  }): Promise<void>;
  close(options?: { keepPort?: boolean }): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  setBaudRate(baudRate: number): Promise<void>;
}

// ------------------------------------------------------------ siac battery

export interface SIBattery {
  cardNumber: number;
  /** When the battery was made. */
  batteryDate: Date | null;
  /** When SPORTident recommend replacing it. */
  replaceBefore: Date | null;
  status: 'ok' | 'due' | 'overdue' | 'unknown';
  /** Negative once overdue, null when unknown. */
  daysRemaining: number | null;
  /** The raw API body, so fields added later are not lost. */
  raw: Record<string, unknown>;
}

export declare const SIAC_BATTERY_API: string;
export declare const SIAC_RANGE: { first: number; last: number };
export declare class SIBatteryLookupError extends SIError {}
export declare function isSiacNumber(cardNumber: number): boolean;
export declare function describeBattery(battery: SIBattery, now?: Date): SIBattery;
/** Resolves null when SPORTident have no record of the card. */
export declare function fetchSiacBattery(
  cardNumber: number,
  options?: {
    clientId?: string;
    signal?: AbortSignal;
    timeout?: number;
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
  }
): Promise<SIBattery | null>;

export declare function isWebSerialSupported(): boolean;
export declare function requestPort(options?: { anyPort?: boolean }): Promise<SISerialPort>;
export declare function getGrantedPorts(): Promise<SISerialPort[]>;

/**
 * Structural stand-in for a WebUSB device, so the declarations stay
 * self-contained whether or not the DOM USB types are loaded.
 */
export interface SIUsbDevice {
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  transferIn(endpointNumber: number, length: number): Promise<unknown>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<unknown>;
}

export declare class WebUsbTransport implements SITransport {
  constructor(
    device: SIUsbDevice,
    handlers?: {
      onData?: (chunk: Uint8Array) => void;
      onError?: (error: Error) => void;
      onClose?: () => void;
    }
  );
  readonly isOpen: boolean;
  readonly device: SIUsbDevice;
  baudRate: number;
  onData: (chunk: Uint8Array) => void;
  onError: (error: Error) => void;
  onClose: () => void;
  open(options?: { baudRate?: number }): Promise<void>;
  close(options?: { keepPort?: boolean }): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  setBaudRate(baudRate: number): Promise<void>;
}

export declare function isWebUsbSupported(): boolean;
export declare function requestUsbDevice(options?: {
  anyDevice?: boolean;
}): Promise<SIUsbDevice>;
export declare function getGrantedUsbDevices(): Promise<SIUsbDevice[]>;

/** Anything SIStation.open() accepts. */
export type SIStationSource = SISerialPort | SIUsbDevice | SITransport;

export declare function transportSupport(): {
  webSerial: boolean;
  webUsb: boolean;
  any: boolean;
};
export declare function requestStation(options?: {
  prefer?: 'auto' | 'serial' | 'usb';
  anyPort?: boolean;
}): Promise<SISerialPort | SIUsbDevice>;
export declare function getGrantedStations(): Promise<Array<SISerialPort | SIUsbDevice>>;
export declare function toTransport(
  source: SIStationSource,
  handlers?: {
    onData?: (chunk: Uint8Array) => void;
    onError?: (error: Error) => void;
    onClose?: () => void;
  }
): SITransport;

// -------------------------------------------------------------------- classes

export declare class SIStation extends EventTarget {
  constructor(transport: SITransport, options?: SIStationOptions);

  /** Open a station over Web Serial or WebUSB and shake hands with it. */
  static open(source: SIStationSource, options?: SIConnectOptions): Promise<SIStation>;

  debug: boolean;
  wakeup: boolean;
  timeout: number;
  retries: number;
  strictCardChanged: boolean;

  sysval: Uint8Array | null;
  protoConfig: SIProtoConfig | null;
  stationCode: number | null;
  serialNumber: number;
  direct: boolean;

  readonly isOpen: boolean;
  readonly baudRate: number;

  connect(options?: SIConnectOptions): Promise<this>;
  disconnect(): Promise<void>;

  sendCommand(
    cmd: number,
    parameters?: Uint8Array | number[],
    options?: SICommandOptions
  ): Promise<Uint8Array>;
  sendCommandFrames(
    cmd: number,
    parameters?: Uint8Array | number[],
    options?: SICommandOptions
  ): Promise<SIFrame[]>;
  sendRaw(bytes: Uint8Array | number[]): Promise<void>;
  writeAck(): Promise<void>;
  handleUnsolicited(frame: SIFrame): void;
  notifyCardChanged(message: string): void;

  refreshSysval(): Promise<Uint8Array>;
  readInfo(): Promise<SIStationInfo>;

  /** Which station the next command reaches. */
  readonly target: SIStationTarget;
  /** The mode the station is in right now. */
  readonly mode: number | null;
  readonly modeName: string | null;

  setDirect(): Promise<void>;
  setRemote(): Promise<void>;
  setTarget(target: SIStationTarget): Promise<void>;
  /**
   * Keep prodding a sleeping station until it answers. Never blocks; pass a
   * signal to stop early. Resolves true if it woke.
   */
  wake(options?: {
    timeout?: number;
    interval?: number;
    signal?: AbortSignal;
  }): Promise<boolean>;
  /**
   * Run something against the remote station, then return to the cabled one.
   * Wakes the remote station first unless `wake` is false.
   */
  withRemote<T>(
    fn: (station: this) => Promise<T>,
    options?: { wake?: boolean | number; signal?: AbortSignal }
  ): Promise<T>;
  setExtendedProtocol(extended?: boolean): Promise<void>;
  setAutoSend(autoSend?: boolean): Promise<void>;
  /** @returns the mode byte the station accepted, which may differ for beacon modes */
  setOperatingMode(mode: number | SIModeName): Promise<number>;
  /** Write the mode byte unchecked, for modes this library does not name. */
  setModeByte(byte: number): Promise<number>;
  /**
   * Put the station into a SIAC special function. These share one mode byte
   * and are told apart by the control code, so both are written.
   */
  setSiacFunction(name: SIACFunctionName): Promise<{
    mode: number;
    code: number;
    name: string;
  }>;
  /** Which SIAC special function this station performs, or null. */
  readonly siacFunction: string | null;
  setStartMode(): Promise<void>;
  setCheckMode(): Promise<void>;
  setFinishMode(): Promise<void>;
  setReadoutMode(): Promise<void>;
  setClearMode(): Promise<void>;
  setControlMode(): Promise<void>;
  setStationCode(code: number, options?: { preserveFeedback?: boolean }): Promise<void>;
  setFeedback(options?: { audible?: boolean; optical?: boolean }): Promise<void>;
  setActiveTime(minutes: number): Promise<void>;
  setSi6With192Punches(enable?: boolean): Promise<void>;
  setBaudRateLow(): Promise<void>;
  setBaudRateHigh(): Promise<void>;

  getTime(): Promise<Date | null>;
  setTime(time?: Date): Promise<void>;
  getClockOffset(): Promise<number | null>;

  beep(count?: number): Promise<void>;
  eraseBackup(): Promise<void>;
  powerOff(): Promise<void>;
  powerOffRemote(): Promise<void>;

  readBackup(options?: {
    onProgress?: (done: number, total: number) => void;
    now?: Date;
  }): Promise<SIBackupPunch[]>;
  readBackupRecord(offset: number, length?: number): Promise<Uint8Array>;
}

export declare class SIReadout extends SIStation {
  constructor(transport: SITransport, options?: SIReadoutOptions);
  static open(
    source: SIStationSource,
    options?: SIConnectOptions & SIReadoutOptions
  ): Promise<SIReadout>;
  autoRead: boolean;
  autoAck: boolean;
  cardNumber: number | null;
  cardType: SICardType | null;
  busy: boolean;

  autoDetectOnConnect?: boolean;
  detectOnConnect: boolean;

  assertReadoutMode(): void;
  /**
   * Ask the station whether a card is in it right now, rather than waiting for
   * an insertion that may already have happened.
   */
  detectCard(options?: { read?: boolean }): Promise<{
    cardNumber: number;
    cardType: SICardType;
  } | null>;
  readCard(reftime?: Date | null): Promise<SICardData>;
  readCardRaw(): Promise<Uint8Array>;
  ackCard(): Promise<void>;
  waitForCard(options?: {
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<{ cardNumber: number; cardType: SICardType }>;
  pollCard(): boolean;
}

export declare class SIControl extends SIStation {
  constructor(transport: SITransport, options?: SIControlOptions);
  static open(
    source: SIStationSource,
    options?: SIConnectOptions & SIControlOptions
  ): Promise<SIControl>;
  recoverMissedPunches: boolean;
  nextOffset: number | null;
  punches: SIAutosendPunch[];

  assertAutosendMode(): void;
  readPunchAt(offset: number): Promise<SIAutosendPunch>;
  collectPunches(milliseconds?: number): Promise<SIAutosendPunch[]>;
}

export declare class SimulatedTransport implements SITransport {
  constructor(options?: {
    code?: number;
    mode?: number;
    latency?: number;
    serialNumber?: number;
  });
  readonly isOpen: boolean;
  baudRate: number;
  latency: number;
  code: number;
  sysval: Uint8Array;
  backup: Uint8Array;
  card: { cardNumber: number; cardType: SICardType; dump: Uint8Array } | null;

  onData: (chunk: Uint8Array) => void;
  onError: (error: Error) => void;
  onClose: () => void;
  open(): Promise<void>;
  close(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  setBaudRate(baudRate: number): Promise<void>;

  send(cmd: number, data: Uint8Array | number[]): void;
  insertCard(cardNumber: number, options?: { punches?: SIPunch[] }): void;
  removeCard(): void;
  sendPunch(cardNumber: number, time?: Date, memoryOffset?: number | null): void;
  fillBackup(records: Array<{ cardNumber: number; time: Date }>): void;
}

// ------------------------------------------------------------------- decoding

export declare class FrameParser {
  constructor(handlers?: {
    onFrame?: (frame: SIFrame) => void;
    onNak?: () => void;
    onAck?: () => void;
    onGarbage?: (reason: string, bytes: Uint8Array) => void;
  });
  readonly pending: number;
  buffer: Uint8Array;
  push(chunk: Uint8Array): void;
  reset(): Uint8Array;
}

export declare function buildCommand(
  cmd: number,
  parameters?: Uint8Array | number[],
  wakeup?: boolean
): Uint8Array;

export declare function crc16(data: Uint8Array): Uint8Array;
export declare function crcCheck(data: Uint8Array, crc: Uint8Array): boolean;
export declare function toInt(bytes: Uint8Array | number[]): number;
export declare function toBytes(value: number, length: number): Uint8Array;
export declare function concat(...parts: Array<Uint8Array | number[] | number>): Uint8Array;
export declare function hex(bytes: Uint8Array | number[], separator?: string): string;
export declare function fromHex(text: string): Uint8Array;

export declare function decodeCardNumber(number: Uint8Array): number;
export declare function cardTypeFromNumber(cardNumber: number): SICardType | null;
export declare function cardTypeFromDetect(cardNumber: number): SICardType | null;
export declare function decodeTime(
  rawTime: Uint8Array,
  ptd?: number | null,
  reftime?: Date | null
): Date | null;
export declare function decodeStationCode(
  rawCode: number | null,
  ptd?: number | null
): number | null;
export declare function decodeCardData(
  data: Uint8Array,
  cardType: SICardType,
  reftime?: Date | null
): SICardData;
export declare function decodeBackupExtended(memory: Uint8Array): SIBackupPunch[];
export declare function decodeBackupLegacy(memory: Uint8Array, now?: Date): SIBackupPunch[];
export declare function decodeAutosendPunch(
  data: Uint8Array,
  reftime?: Date | null
): SIAutosendPunch;
export declare function extractSysval(
  sysval: Uint8Array,
  offset: number,
  length: number
): Uint8Array;

export declare function weekdayMondayFirst(date: Date): number;
export declare function startOfDay(date: Date): Date;
export declare function atSecondsOfDay(date: Date, seconds: number, ms?: number): Date;
export declare function addDays(date: Date, days: number): Date;
export declare function secondsSinceMidnight(date: Date): number;

// ------------------------------------------------------------------ csv output

export declare function backupToCsv(
  punches: SIBackupPunch[],
  options?: { code?: number; serialNumber?: number; mode?: string; readTime?: Date }
): string;
export declare function sysvalToCsv(sysval: Uint8Array): string;
export declare function rowsToCsv(header: string[], rows: Array<Array<string | number>>): string;
export declare function stationLogRow(
  info: SIStationInfo,
  clockOffsetMs?: number | null,
  now?: Date
): Array<string | number>;
export declare const STATION_LOG_HEADER: string[];
export declare function backupFilename(
  code: number,
  mode: string,
  serialNumber: number
): string;
export declare function downloadText(filename: string, text: string): void;
export declare function formatDateTime(date: Date): string;
export declare function formatTimeOfDay(date: Date): string;

// -------------------------------------------------------------------- errors

export declare class SIError extends Error {}
export declare class SITimeoutError extends SIError {}
export declare class SIProtocolError extends SIError {}
export declare class SINakError extends SIProtocolError {}
export declare class SICardChangedError extends SIError {}
export declare class SIConnectionError extends SIError {}

// ----------------------------------------------------------------- constants

export declare const CMD: Record<string, number>;
export declare const BC: Record<string, number>;
export declare const O: Record<string, number>;
export declare const MODE: {
  SIAC_SPECIAL: number; CONTROL: number; START: number; FINISH: number;
  READOUT: number; CLEAR_OLD: number; CLEAR: number; CHECK: number;
  PRINTOUT: number; START_TRIG: number; FINISH_TRIG: number;
  BC_CONTROL: number; BC_START: number; BC_FINISH: number; BC_READOUT: number;
};
export declare const MODE_NAMES: Record<number, string>;
export declare const MODEL_NAMES: Record<number, string>;
export declare const CARD: Record<SICardType, Record<string, number | null>>;
export declare const SUPPORTED_MODES: number[];
export declare const SUPPORTED_READ_BACKUP_MODES: number[];
export declare const USB_FILTERS: Array<{ usbVendorId: number; usbProductId?: number }>;
export declare const BAUD_HIGH: number;
export declare const BAUD_LOW: number;
export declare const STX: number;
export declare const ETX: number;
export declare const ACK: number;
export declare const NAK: number;
export declare const WAKEUP: number;
export declare const REC_LEN: number;
export declare const TIME_RESET: number;
export declare const REMOTE_OFF: Uint8Array;
