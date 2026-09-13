// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2008-2023 Gaudenz Steinlin, Simon Harston, Jan Vorwerk,
//                         Per Magnusson (sireader2.py)
// Copyright (C) 2026 dulcilubio (JavaScript port)
// See NOTICE and LICENSE at the repository root.

/**
 * SportIdent protocol constants.
 *
 * Ported from sireader2.py by Per Magnusson, which is itself an extended version
 * of sireader.py by Gaudenz Steinlin, Simon Harston and Jan Vorwerk.
 * Licensed under GPL-3.0, like the original.
 *
 * In the Python original these were single-byte `bytes` objects. Here they are
 * plain numbers, which is what you actually want when you are indexing into a
 * Uint8Array.
 */

export const CRC_POLYNOM = 0x8005;
export const CRC_BITF = 0x8000;

/** Framing bytes. */
export const STX = 0x02; // Start of transmission
export const ETX = 0x03; // End of transmission
export const ACK = 0x06; // Sent to the station after a readout to make it beep
export const NAK = 0x15; // Negative acknowledge
export const DLE = 0x10; // Delimiter (legacy autosend data)
export const WAKEUP = 0xff; // Sent before a command to wake a sleeping station

/**
 * Basic (legacy) protocol commands. Kept for documentation; the library talks
 * the extended protocol to the directly connected station.
 */
export const BC = {
  SET_CARDNO: 0x30,
  GET_SI5: 0x31, // read out SI-Card 5 data
  TRANS_REC: 0x33, // autosend timestamp on very old stations (BSF3)
  SI5_WRITE: 0x43,
  SI5_DET: 0x46, // SI-Card 5 inserted (46 49) or removed (46 4F)
  TRANS_REC2: 0x53, // autosend timestamp (online control)
  TRANS_TIME: 0x54, // autosend timestamp (lightbeam trigger)
  GET_SI6: 0x61,
  SI6_WRITEPAGE: 0x62,
  SI6_READWORD: 0x63,
  SI6_WRITEWORD: 0x64,
  SI6_DET: 0x66,
  SET_MS: 0x70, // 0x4D = "M"aster, 0x53 = "S"lave
  GET_MS: 0x71,
  SET_SYS_VAL: 0x72,
  GET_SYS_VAL: 0x73,
  GET_BACKUP: 0x74, // note: the response carries 0xC4
  ERASE_BACKUP: 0x75,
  SET_TIME: 0x76,
  GET_TIME: 0x77,
  OFF: 0x78,
  RESET: 0x79,
  GET_BACKUP2: 0x7a, // extended start/finish only; response carries 0xCA
  SET_BAUD: 0x7e, // 0x00 = 4800 baud, 0x01 = 38400 baud
};

/** Extended protocol commands. */
export const CMD = {
  GET_BACKUP: 0x81, // 3 address bytes + 1 length byte (max 0x80)
  SET_SYS_VAL: 0x82,
  GET_SYS_VAL: 0x83,
  SRR_WRITE: 0xa2, // ShortRangeRadio, SysData write
  SRR_READ: 0xa3,
  SRR_QUERY: 0xa6,
  SRR_PING: 0xa7, // heartbeat from linked devices, every 50 s
  SRR_ADHOC: 0xa8,
  GET_SI5: 0xb1,
  SI5_WRITE: 0xc3,
  TRANS_REC: 0xd3, // autosend punch record (online control)
  CLEAR_CARD: 0xe0,
  GET_SI6: 0xe1,
  SI5_DET: 0xe5, // SI-Card 5 inserted
  SI6_DET: 0xe6, // SI-Card 6 inserted
  SI_REM: 0xe7, // card removed
  SI9_DET: 0xe8, // SI-Card 8/9/10/11/p/t inserted
  SI9_WRITE: 0xea,
  GET_SI9: 0xef,
  SET_MS: 0xf0,
  GET_MS: 0xf1,
  ERASE_BACKUP: 0xf5,
  SET_TIME: 0xf6,
  GET_TIME: 0xf7,
  OFF: 0xf8,
  BEEP: 0xf9,
  SET_BAUD: 0xfe,
};

/**
 * What SPORTident Config+ sends to switch off the remote station. It looks
 * nothing like a normal command frame, so it is sent as raw bytes.
 */
export const REMOTE_OFF = Uint8Array.from([
  0xff, 0x40, 0x0f, 0x80, 0xb2, 0xb6, 0x50, 0xc0,
]);

/** Command parameters. */
export const P_MS_DIRECT = 0x4d; // "M"aster, station talks for itself
export const P_MS_INDIRECT = 0x53; // "S"lave, station relays to a remote station
export const P_SI6_CB = 0x08; // read all card blocks

/**
 * Offsets into the system data block (SYS_VAL), read with GET_SYS_VAL 0x00 0x80.
 *
 * Note: the first byte of the returned data is not covered by these offsets
 * (it always seems to be 0), so `extractSysval` adds 1. Thanks to Simon Harston
 * for most of this information.
 */
export const O = {
  OLD_SERIAL: 0x00, // 2 bytes, only up to BSx6, numbers < 65536
  OLD_CPU_ID: 0x02, // 2 bytes, only up to BSx6
  SERIAL_NO: 0x00, // 4 bytes, only after BSx7. If byte 0x00 > 0, use OLD offsets
  SRR_CFG: 0x04, // 1 byte: bit1 auto send SIAC data, bit2 sync time via radio
  FIRMWARE: 0x05, // 3 bytes, ASCII (e.g. "656")
  BUILD_DATE: 0x08, // 3 bytes, YYMMDD
  MODEL_ID: 0x0b, // 2 bytes, see MODEL_NAMES
  MEM_SIZE: 0x0d, // 1 byte, in KB
  BAT_DATE: 0x15, // 3 bytes, YYMMDD
  BAT_CAP: 0x19, // 2 bytes, battery capacity, multiply by 16/225 for mAh
  BACKUP_PTR_HI: 0x1c, // 2 bytes, high bytes of the backup memory pointer
  BACKUP_PTR_LO: 0x21, // 2 bytes, low bytes of the backup memory pointer
  SI6_CB: 0x33, // 1 byte, which SI-Card 6 blocks to read (0xC1 = 3 blocks, 0xFF = all 8)
  SRR_CHANNEL: 0x34, // 1 byte, 0x00 = "red", 0x01 = "blue"
  USED_BAT_CAP: 0x35, // 3 bytes, multiply by 2.778e-5 for percent used
  MEM_OVERFLOW: 0x3d, // 1 byte, memory overflowed if != 0
  BAT_VOLT: 0x50, // 2 bytes, multiply by 5/65536 for volts
  PROGRAM: 0x70, // 1 byte, bit5: 0 = competition, 1 = training
  MODE: 0x71, // 1 byte, see MODE
  STATION_CODE: 0x72, // 1 byte, lower bits of the station code
  FEEDBACK: 0x73, // 1 byte: bit0 optical, bit2 audible, bits 7-6 high bits of code
  PROTO: 0x74, // 1 byte: bit0 extended, bit1 autosend, bit2 handshake,
  //            bit4 password only, bit7 read card after punch
  WAKEUP_DATE: 0x75, // 3 bytes, YYMMDD
  WAKEUP_TIME: 0x78, // 3 bytes, 1 day byte + 2 bytes seconds after midnight/midday
  SLEEP_TIME: 0x7b, // 3 bytes, same encoding as WAKEUP_TIME
  ACTIVE_TIME: 0x7e, // 2 bytes, minutes, max 5759 (< 96 h)
};

/** Station operating modes. */
export const MODE = {
  SIAC_SPECIAL: 0x01,
  CONTROL: 0x02,
  START: 0x03,
  FINISH: 0x04,
  READOUT: 0x05,
  CLEAR_OLD: 0x06, // without start number, not used anymore
  CLEAR: 0x07, // with start number, the standard
  CHECK: 0x0a,
  PRINTOUT: 0x0b, // BS7-P printer station, also used by the SRR receiver module
  START_TRIG: 0x0c, // BS7-S (Sprinter) with external trigger
  FINISH_TRIG: 0x0d,
  BC_CONTROL: 0x12, // SI Air+ / SIAC beacon mode
  BC_START: 0x13,
  BC_FINISH: 0x14,
  BC_READOUT: 0x15,

  // Newer Air+ stations (BSF9 and later, and some BSF8s) report and accept the
  // beacon modes 0x20 higher. On those, writing the 0x12 form is answered with
  // a NAK. Thanks to the Paxy/sportident-python scripts for pinning this down.
  BC_CONTROL_NEW: 0x32,
  BC_START_NEW: 0x33,
  BC_FINISH_NEW: 0x34,
  BC_READOUT_NEW: 0x35,
};

/**
 * The SIAC special functions. A station in one of these does nothing else.
 *
 * They are identified by a mode byte *and* a control code together, not by
 * either alone: code 124 means SIAC ON at mode 0x01 and SIAC test at 0x11.
 * That is also why Config+ will not let you edit the code in these modes -- it
 * owns that field.
 *
 * Read off five BSF8s (firmware 656) set with Config+, each confirmed twice.
 * SPORTident document the functions but publish none of these numbers, and
 * sireader2.py has only mode 0x01 with the comment "SIAC special (ON, OFF,
 * Radio_ReadOut, etc.)".
 *
 * Two loose ends, recorded rather than guessed at:
 *
 * - Code 126 at mode 0x01 is unused by any station seen here.
 * - The SIAC test station also carried PROGRAM 0x30 where the other four had
 *   0x38. Whether that bit matters to how the station behaves is unknown, so
 *   nothing here writes it.
 */
export const SIAC_FUNCTIONS = [
  { key: 'battery-test', name: 'SIAC battery test', mode: 0x01, code: 123 },
  { key: 'on', name: 'SIAC ON', mode: 0x01, code: 124 },
  { key: 'off', name: 'SIAC OFF', mode: 0x01, code: 125 },
  { key: 'radio-readout', name: 'SIAC radio readout', mode: 0x01, code: 127 },
  { key: 'test', name: 'SIAC test', mode: 0x11, code: 124 },
];

/** Every mode byte that means "a SIAC special function". */
export const SIAC_MODES = [0x01, 0x11];

/** Look one up by the pair that identifies it. */
export function siacFunctionFor(mode, code) {
  return SIAC_FUNCTIONS.find((f) => f.mode === mode && f.code === code) ?? null;
}

/** Look one up by the name setSiacFunction() takes. */
export function siacFunctionByKey(key) {
  return SIAC_FUNCTIONS.find((f) => f.key === key) ?? null;
}

/** Older beacon mode byte -> the form newer stations want. */
export const BEACON_OLD_TO_NEW = {
  [0x12]: 0x32,
  [0x13]: 0x33,
  [0x14]: 0x34,
  [0x15]: 0x35,
};

/** Every beacon mode byte, either generation. */
export const BEACON_MODES = [0x12, 0x13, 0x14, 0x15, 0x32, 0x33, 0x34, 0x35];

export const SUPPORTED_MODES = [
  MODE.CONTROL,
  MODE.START,
  MODE.FINISH,
  MODE.READOUT,
  MODE.CLEAR,
  MODE.CHECK,
];

export const SUPPORTED_READ_BACKUP_MODES = [
  MODE.CONTROL,
  MODE.START,
  MODE.FINISH,
  MODE.CLEAR_OLD,
  MODE.CLEAR,
  MODE.CHECK,
];

/**
 * The modes you can set by name, for UIs and command lines. Keys match the
 * words printed on the station and used in Config+.
 */
export const MODE_BY_NAME = {
  control: MODE.CONTROL,
  start: MODE.START,
  finish: MODE.FINISH,
  readout: MODE.READOUT,
  clear: MODE.CLEAR,
  check: MODE.CHECK,
  // Air+ / SIAC beacon modes. Written as the 0x12 form first; stations that
  // refuse it get the 0x32 form instead.
  'beacon-control': MODE.BC_CONTROL,
  'beacon-start': MODE.BC_START,
  'beacon-finish': MODE.BC_FINISH,
  'beacon-readout': MODE.BC_READOUT,
};

export const MODE_NAMES = {
  [MODE.SIAC_SPECIAL]: 'SIAC special',
  [MODE.CONTROL]: 'Control',
  [MODE.START]: 'Start',
  [MODE.FINISH]: 'Finish',
  [MODE.READOUT]: 'Readout',
  [MODE.CLEAR_OLD]: 'Clear old',
  [MODE.CLEAR]: 'Clear',
  [MODE.CHECK]: 'Check',
  [MODE.PRINTOUT]: 'Printout',
  [MODE.START_TRIG]: 'Start trig',
  [MODE.FINISH_TRIG]: 'Finish trig',
  [MODE.BC_CONTROL]: 'BC control',
  [MODE.BC_START]: 'BC start',
  [MODE.BC_FINISH]: 'BC finish',
  [MODE.BC_READOUT]: 'BC readout',
  [MODE.BC_CONTROL_NEW]: 'BC control',
  [MODE.BC_START_NEW]: 'BC start',
  [MODE.BC_FINISH_NEW]: 'BC finish',
  [MODE.BC_READOUT_NEW]: 'BC readout',
};

export const MODEL_NAMES = {
  0x6f21: 'SIMSRR1-AP', // ShortRangeRadio access point (SRR dongle)
  0x8003: 'BSF3',
  0x8004: 'BSF4',
  0x8084: 'BSM4-RS232',
  0x8086: 'BSM6-RS232/USB',
  0x8115: 'BSF5',
  0x8117: 'BSF7',
  0x8118: 'BSF8',
  0x8146: 'BSF6',
  0x8187: 'BS7-SI-Master',
  0x8188: 'BS8-SI-Master',
  0x8197: 'BSF7',
  0x8198: 'BSF8',
  0x9197: 'BSM7-RS232/USB',
  0x9198: 'BSM8-USB/SRR',
  0x9199: 'unknown',
  0x9597: 'BS7-S', // Sprinter
  0x9d9a: 'BS11-BL', // SIAC / Air+
  0xb197: 'BS7-P',
  0xb198: 'BS8-P',
  0xb897: 'BS7-GSM',
  0xcd9b: 'BS11-BS', // red or blue, SIAC / Air+
};

/**
 * How cards encode text above 0x7f.
 *
 * Cards store names and addresses in a DOS code page, not Latin-1 -- 0x84 is
 * "ä" here, where Latin-1 would give "„". Code page 437 matches what real
 * cards contain; the card's own character set byte selects it.
 */
export const CARD_TEXT = {
  0x80: 'Ç',
  0x81: 'ü',
  0x82: 'é',
  0x83: 'â',
  0x84: 'ä',
  0x85: 'à',
  0x86: 'å',
  0x87: 'ç',
  0x88: 'ê',
  0x89: 'ë',
  0x8a: 'è',
  0x8b: 'ï',
  0x8c: 'î',
  0x8d: 'ì',
  0x8e: 'Ä',
  0x8f: 'Å',
  0x90: 'É',
  0x91: 'æ',
  0x92: 'Æ',
  0x93: 'ô',
  0x94: 'ö',
  0x95: 'ò',
  0x96: 'û',
  0x97: 'ù',
  0x98: 'ÿ',
  0x99: 'Ö',
  0x9a: 'Ü',
  0x9b: '¢',
  0x9c: '£',
  0x9d: '¥',
  0x9e: '₧',
  0x9f: 'ƒ',
  0xa0: 'á',
  0xa1: 'í',
  0xa2: 'ó',
  0xa3: 'ú',
  0xa4: 'ñ',
  0xa5: 'Ñ',
  0xa6: 'ª',
  0xa7: 'º',
  0xa8: '¿',
  0xa9: '⌐',
  0xaa: '¬',
  0xab: '½',
  0xac: '¼',
  0xad: '¡',
  0xae: '«',
  0xaf: '»',
  0xb0: '░',
  0xb1: '▒',
  0xb2: '▓',
  0xb3: '│',
  0xb4: '┤',
  0xb5: '╡',
  0xb6: '╢',
  0xb7: '╖',
  0xb8: '╕',
  0xb9: '╣',
  0xba: '║',
  0xbb: '╗',
  0xbc: '╝',
  0xbd: '╜',
  0xbe: '╛',
  0xbf: '┐',
  0xc0: '└',
  0xc1: '┴',
  0xc2: '┬',
  0xc3: '├',
  0xc4: '─',
  0xc5: '┼',
  0xc6: '╞',
  0xc7: '╟',
  0xc8: '╚',
  0xc9: '╔',
  0xca: '╩',
  0xcb: '╦',
  0xcc: '╠',
  0xcd: '═',
  0xce: '╬',
  0xcf: '╧',
  0xd0: '╨',
  0xd1: '╤',
  0xd2: '╥',
  0xd3: '╙',
  0xd4: '╘',
  0xd5: '╒',
  0xd6: '╓',
  0xd7: '╫',
  0xd8: '╪',
  0xd9: '┘',
  0xda: '┌',
  0xdb: '█',
  0xdc: '▄',
  0xdd: '▌',
  0xde: '▐',
  0xdf: '▀',
  0xe0: 'α',
  0xe1: 'ß',
  0xe2: 'Γ',
  0xe3: 'π',
  0xe4: 'Σ',
  0xe5: 'σ',
  0xe6: 'µ',
  0xe7: 'τ',
  0xe8: 'Φ',
  0xe9: 'Θ',
  0xea: 'Ω',
  0xeb: 'δ',
  0xec: '∞',
  0xed: 'φ',
  0xee: 'ε',
  0xef: '∩',
  0xf0: '≡',
  0xf1: '±',
  0xf2: '≥',
  0xf3: '≤',
  0xf4: '⌠',
  0xf5: '⌡',
  0xf6: '÷',
  0xf7: '≈',
  0xf8: '°',
  0xf9: '∙',
  0xfa: '·',
  0xfb: '√',
  0xfc: 'ⁿ',
  0xfd: '²',
  0xfe: '■',
  0xff: ' ',
};

/** Length of a backup memory record in the extended protocol. */
export const REC_LEN = 8; // 6 in the legacy protocol

/** A time field set to this means "no time recorded". */
export const TIME_RESET = 0xeeee;

/**
 * Layout of the data read from each card type.
 *
 * CN2/CN1/CN0 are the card number bytes, ST/FT/CT/LT are start, finish, check
 * and clear times, xTD are the matching day bytes, SN/FN/CHN/LN the matching
 * station codes, RC the punch counter, P1 the offset of the first punch,
 * PL the punch record length, PM the maximum punch count, and CN/PTD/PTH/PTL
 * the offsets inside a punch record. BC is the number of card blocks to read.
 */
export const CARD = {
  SI5: {
    CN2: 6, CN1: 4, CN0: 5,
    STD: null, SN: null, ST: 19,
    FTD: null, FN: null, FT: 21,
    CTD: null, CHN: null, CT: 25,
    LTD: null, LN: null, LT: null,
    RC: 23,
    P1: 32, PL: 3, PM: 30, // punches 31-36 have no time
    CN: 0, PTD: null, PTH: 1, PTL: 2,
  },
  SI6: {
    CN2: 11, CN1: 12, CN0: 13,
    STD: 24, SN: 25, ST: 26,
    FTD: 20, FN: 21, FT: 22,
    CTD: 28, CHN: 29, CT: 30,
    LTD: 32, LN: 33, LT: 34,
    RC: 18,
    P1: 128, PL: 4, PM: 64,
    CN: 1, PTD: 0, PTH: 2, PTL: 3,
  },
  SI8: {
    CN2: 25, CN1: 26, CN0: 27,
    STD: 12, SN: 13, ST: 14,
    FTD: 16, FN: 17, FT: 18,
    CTD: 8, CHN: 9, CT: 10,
    LTD: null, LN: null, LT: null,
    RC: 22,
    // Two blocks are read, 256 bytes, punches from 136: (256-136)/4 = 30.
    // SPORTident document the SI-Card 8 as holding 30 records.
    P1: 136, PL: 4, PM: 30,
    CN: 1, PTD: 0, PTH: 2, PTL: 3,
    BC: 2,
  },
  SI9: {
    CN2: 25, CN1: 26, CN0: 27,
    STD: 12, SN: 13, ST: 14,
    FTD: 16, FN: 17, FT: 18,
    CTD: 8, CHN: 9, CT: 10,
    LTD: null, LN: null, LT: null,
    RC: 22,
    P1: 56, PL: 4, PM: 50,
    CN: 1, PTD: 0, PTH: 2, PTL: 3,
    BC: 2,
  },
  pCard: {
    CN2: 25, CN1: 26, CN0: 27,
    STD: 12, SN: 13, ST: 14,
    FTD: 16, FN: 17, FT: 18,
    CTD: 8, CHN: 9, CT: 10,
    LTD: null, LN: null, LT: null,
    RC: 22,
    P1: 176, PL: 4, PM: 20,
    CN: 1, PTD: 0, PTH: 2, PTL: 3,
    BC: 2,
  },
  SI10: {
    // Also covers SI11, SIAC and tCard
    CN2: 25, CN1: 26, CN0: 27,
    STD: 12, SN: 13, ST: 14,
    FTD: 16, FN: 17, FT: 18,
    CTD: 8, CHN: 9, CT: 10,
    LTD: null, LN: null, LT: null,
    RC: 22,
    P1: 128, // would be 512 if all blocks were read, but blocks 1-3 are skipped
    // Five blocks are read, 640 bytes, punches from 128: (640-128)/4 = 128,
    // which is what SPORTident document for SI-Card 10, 11 and SIAC. This
    // said 64 before, which threw away every punch after the 64th.
    PL: 4, PM: 128,
    CN: 1, PTD: 0, PTH: 2, PTL: 3,
    BC: 8,
  },
};

/** Punch record layout in the autosend (control mode) frame. */
export const T_OFFSET = 8;
export const T_CN = 0;
export const T_TIME = 5;

/** Punch record layout when a single record is read back from backup memory. */
export const BC_CN = 3;
export const BC_TIME = 8;

/** Backup memory layout, extended protocol. */
export const BUX = {
  FIRST: 2, // first punch starts here in the returned data (+1 like the O_ offsets)
  SIZE: 8, // bytes per record
  CN: 0, // 3 bytes, MSB first
  YM: 3, // bits 7-2 year (0 = 2000), bits 1-0 high bits of month
  MDAP: 4, // bits 7-6 low bits of month, bits 5-1 day, bit 0 am/pm
  SECS: 5, // 2 bytes, seconds since midnight or midday
  MS: 7, // 1 byte, divide by 256 for fractional seconds
};

/** Backup memory layout, legacy protocol. */
export const BUL = {
  FIRST: 2,
  SIZE: 6,
  CN: 0, // 2 bytes, lower part of the card number
  SECS: 2, // 2 bytes, seconds since midnight/midday
  PTD: 4, // bit0 am/pm, bits 3-1 day of week, bits 5-4 week counter, bits 7-6 code high
  CNS: 5, // card number series
};

/** USB identifiers worth offering in the Web Serial port picker. */
export const USB_FILTERS = [
  { usbVendorId: 0x10c4, usbProductId: 0x800a }, // SPORTident USB station (CP210x)
  { usbVendorId: 0x10c4, usbProductId: 0xea60 }, // generic Silicon Labs CP210x
  { usbVendorId: 0x0403 }, // FTDI serial adapters (RS232 stations)
];

/**
 * How long to spend rousing a station on the coupling stick, in ms.
 *
 * Measured on a BSF8 coming out of a real sleep: 31 attempts over 22.8 seconds
 * of continuous traffic before it answered at all. Five seconds sounds
 * reasonable and is not close to enough.
 */
export const WAKE_TIMEOUT = 30000;

export const BAUD_HIGH = 38400;
export const BAUD_LOW = 4800;
