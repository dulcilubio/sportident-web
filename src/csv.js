/**
 * CSV export.
 *
 * The backup file matches the layout SPORTident Config+ writes, so the output
 * drops straight into whatever already reads those files.
 */

const DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const SEPARATOR = ';';

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/** "2026-09-10 14:32:07" */
export function formatDateTime(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** "14:32:07.125" */
export function formatTimeOfDay(date) {
  return (
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`
  );
}

function quote(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  return rows.map((row) => row.map(quote).join(SEPARATOR)).join('\r\n') + '\r\n';
}

/**
 * Turn backup memory records into a Config+ style CSV.
 *
 * @param {import('./protocol.js').SIBackupPunch[]} punches
 * @param {object} [options]
 * @param {number} [options.code] control code
 * @param {number} [options.serialNumber]
 * @param {string} [options.mode] Control, Check, Start, Clear or Finish
 * @param {Date} [options.readTime] when the station was read out
 * @returns {string}
 */
export function backupToCsv(punches, { code = 0, mode = '', readTime = new Date() } = {}) {
  const rows = [
    [
      'No', 'Read on', 'SIID', 'Control time', 'Battery voltage', 'Serial number',
      'Code number', 'DayOfWeek', 'Punch DateTime', 'Operating mode', 'SIAC number',
      'SIAC Count', 'SIAC radio mode', 'SIAC is battery low', 'SIAC is card full',
      'SIAC beacon mode', 'SIAC is gate mode', '',
    ],
  ];
  const readOn = formatDateTime(readTime);

  punches.forEach((punch, index) => {
    const date = punch.time;
    const datePart =
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}   `;

    let controlTime;
    let dayName;
    let timeOfDay;
    if (punch.error) {
      controlTime = datePart + punch.error;
      dayName = '';
      timeOfDay = '00:00:00';
    } else {
      controlTime = datePart + formatTimeOfDay(date);
      dayName = DAY_NAMES[date.getDay()];
      timeOfDay = formatTimeOfDay(date);
    }

    rows.push([
      index + 1, readOn, punch.cardNumber, controlTime, '', '', code,
      dayName, timeOfDay, mode, '0', '1', '', '', '', '', '', '',
    ]);
  });

  return toCsv(rows);
}

/**
 * Dump the raw system data block as offset/value pairs, the way
 * `save_sys_val` does.
 * @param {Uint8Array} sysval
 */
export function sysvalToCsv(sysval) {
  const rows = [['Offset', 'Value']];
  // The first byte of the reply is not part of the addressable block.
  for (let i = 1; i < sysval.length; i++) {
    rows.push([i - 1, sysval[i]]);
  }
  return toCsv(rows);
}

/** Column headings used by the station log, matching si_normalize_station.py. */
export const STATION_LOG_HEADER = [
  'Date', 'Time', 'SerialNo', 'Hardware', 'Software', 'BatteryDate', 'BattUsage',
  'Voltage', 'CodeNo', 'Mode', 'TimeDiff', 'OpTime', 'Autosend', 'LegacyProtocol',
  'Card6with192punches', 'AcousticSignal', 'OpticalSignal1', 'ProductionDate',
  'MemorySize', 'BatteryCapacity',
];

/**
 * One row of the station log.
 * @param {object} info the object returned by `station.readInfo()`
 * @param {number|null} clockOffsetMs station clock minus computer clock
 * @param {Date} [now]
 */
export function stationLogRow(info, clockOffsetMs = null, now = new Date()) {
  let timeDiff = '';
  if (clockOffsetMs !== null) {
    const sign = clockOffsetMs < 0 ? '-' : '';
    const total = Math.abs(clockOffsetMs);
    const ms = Math.floor(total % 1000);
    const seconds = Math.floor(total / 1000) % 60;
    const minutes = Math.floor(total / 60000) % 60;
    const hours = Math.floor(total / 3600000);
    timeDiff = `${sign}${hours}:${pad(minutes)}:${pad(seconds)}.${pad(ms, 3)}`;
  }

  return [
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    info.serialNumber,
    info.modelName,
    info.firmware,
    info.batteryDate,
    `${info.batteryUsedPercent.toFixed(1)} %`,
    info.voltage.toFixed(2),
    info.code,
    info.modeName,
    timeDiff,
    info.activeTime,
    info.autoSend ? 'Autosend' : '-',
    info.extendedProtocol ? '-' : 'LegacyProtocol!',
    info.si6With192Punches === true
      ? 'Card6With192Records!'
      : info.si6With192Punches === false
        ? '-'
        : `0x${Number(info.si6With192Punches).toString(16).padStart(2, '0')}`,
    info.audibleFeedback ? 'AcousticSignal' : '',
    info.opticalFeedback ? 'OpticalSignal1' : '',
    info.buildDate,
    `${info.memorySizeKb} K`,
    String(Math.round(info.batteryCapacityMah)),
  ];
}

/** Build a CSV from a header and rows. */
export function rowsToCsv(header, rows) {
  return toCsv([header, ...rows]);
}

/**
 * Offer a string to the user as a file download. Browser only.
 * @param {string} filename
 * @param {string} text
 */
export function downloadText(filename, text) {
  // A BOM keeps Excel happy with the semicolon separator.
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `123_Control_198765.csv`, the naming Config+ uses. */
export function backupFilename(code, mode, serialNumber) {
  return `${code}_${mode || 'Unknown'}_${serialNumber}.csv`;
}
