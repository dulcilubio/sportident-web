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
};

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
    P1: 136, PL: 4, PM: 50,
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
    PL: 4, PM: 64,
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

export const BAUD_HIGH = 38400;
export const BAUD_LOW = 4800;
