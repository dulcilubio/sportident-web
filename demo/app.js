// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2008-2023 Gaudenz Steinlin, Simon Harston, Jan Vorwerk,
//                         Per Magnusson (sireader2.py)
// Copyright (C) 2026 dulcilubio (JavaScript port)
// See NOTICE and LICENSE at the repository root.

/**
 * Demo for the sportident-web library.
 *
 * Serve this folder over http (Web Serial needs a secure context and module
 * imports do not work from file://):
 *
 *   python3 -m http.server 8080
 *   open http://localhost:8080/demo/
 */

import {
  BEACON_OLD_TO_NEW,
  backupFilename,
  backupToCsv,
  downloadText,
  formatDateTime,
  formatTimeOfDay,
  hex,
  MODE,
  MODE_BY_NAME,
  requestStation,
  rowsToCsv,
  SimulatedTransport,
  SIReadout,
  sysvalToCsv,
  toTransport,
  transportSupport,
} from '../src/index.js';

const $ = (id) => document.getElementById(id);
const ui = {
  connect: $('connect'),
  connectUsb: $('connectUsb'),
  simulate: $('simulate'),
  disconnect: $('disconnect'),
  status: $('status'),
  facts: $('facts'),
  cards: $('cards'),
  log: $('log'),
  showHex: $('showHex'),
  circle: $('circle'),
  circleText: $('circleText'),
  support: $('support'),
  progress: $('progress'),
  resultsHeading: $('resultsHeading'),
};

let station = null;
let simulator = null;
let readCards = [];

// ------------------------------------------------------------------ connecting

const support = transportSupport();

if (!support.any) {
  ui.support.hidden = false;
  ui.support.textContent =
    'This browser can reach a station through neither Web Serial nor WebUSB. Chrome or ' +
    'Edge can, on desktop and Android. The simulator below works anywhere.';
  ui.connect.disabled = true;
  ui.connectUsb.disabled = true;
} else if (!support.webSerial) {
  // Android: WebUSB only.
  ui.support.hidden = false;
  ui.support.textContent =
    'No Web Serial here, so the station is reached over WebUSB. Plug it in with an OTG cable.';
} else if (!support.webUsb) {
  ui.connectUsb.hidden = true;
}

/** @param {'auto'|'serial'|'usb'} prefer */
async function connectWith(prefer) {
  try {
    const source = await requestStation({ prefer });
    await attach(new SIReadout(toTransport(source)));
  } catch (error) {
    if (error?.name === 'NotFoundError') return; // the picker was dismissed
    fail(error);
  }
}

ui.connect.addEventListener('click', () => connectWith('auto'));

// Worth its own button because on macOS the serial picker is often empty --
// Apple's driver ignores SPORTident's product id -- while WebUSB still works.
ui.connectUsb.addEventListener('click', () => connectWith('usb'));

ui.simulate.addEventListener('click', async () => {
  simulator = new SimulatedTransport({ code: 31, mode: MODE.READOUT });
  await attach(new SIReadout(simulator));
  setStatus('live', 'Simulated station, no hardware attached');
  scheduleSimulatedCards();
});

ui.disconnect.addEventListener('click', async () => {
  await station?.disconnect().catch(() => {});
  station = null;
  simulator = null;
  setStatus('', 'Nothing connected');
  $('currentMode').textContent = 'unknown';
  $('remotePanel').hidden = true;
  $('cancelWake').hidden = true;
  showMode();
  showTarget();
  ui.facts.replaceChildren();
  setCircle(null);
  setControlsEnabled(false);
});

async function attach(next) {
  station = next;
  setStatus('warn', 'Opening the port…');

  station.addEventListener('tx', (e) => logBytes('tx', e.detail.bytes));
  station.addEventListener('rx', (e) => logBytes('rx', e.detail.bytes));
  station.addEventListener('error', (e) => fail(e.detail.error));
  station.addEventListener('garbage', (e) => write('err', `dropped: ${e.detail.reason}`));
  station.addEventListener('close', () => setStatus('bad', 'The station went away'));
  station.addEventListener('cardInserted', (e) =>
    setStatus('warn', `Reading card ${e.detail.cardNumber}…`)
  );
  station.addEventListener('cardRemoved', () => setStatus('live', 'Ready for the next card'));
  station.addEventListener('card', (e) => addCard(e.detail));
  station.addEventListener('cardError', (e) => fail(e.detail.error));
  station.addEventListener('punch', (e) => addPunch(e.detail));

  try {
    await station.connect();
  } catch (error) {
    fail(error);
    station = null;
    return;
  }

  await refreshFacts();
  showMode();
  showTarget();
  showPunchMode();
  showFeedback();
  setControlsEnabled(true);
  setStatus('live', 'Connected and listening');
}

// -------------------------------------------------------------- station panel

let lastInfo = null;

async function refreshFacts() {
  if (!station) return;
  const info = await station.readInfo();
  lastInfo = info;
  const offset = await station.getClockOffset();

  setCircle(info.code);
  ui.resultsHeading.textContent =
    info.mode === MODE.READOUT ? 'Cards read' : `Punches at control ${info.code}`;

  const rows = [
    ['Control code', info.code],
    ['Mode', info.modeName],
    ['Model', info.modelName],
    ['Serial number', info.serialNumber],
    ['Firmware', info.firmware],
    ['Battery', `${info.voltage.toFixed(2)} V`],
    ['Battery used', `${info.batteryUsedPercent.toFixed(1)} %`],
    ['Memory', `${info.memorySizeKb} kB${info.memoryOverflow ? ' (full)' : ''}`],
    ['Stays awake for', info.activeTime],
    ['Protocol', info.extendedProtocol ? 'Extended' : 'Legacy'],
    ['Sends punches live', info.autoSend ? 'Yes' : 'No'],
    ['Clock difference', offset === null ? 'unreadable' : `${(offset / 1000).toFixed(2)} s`],
    ['Beeps on punch', info.audibleFeedback ? 'Yes' : 'No'],
    ['Flashes on punch', info.opticalFeedback ? 'Yes' : 'No'],
    ['Built', info.buildDate],
    ['Battery fitted', info.batteryDate],
    ['Battery capacity', `${info.batteryCapacityMah} mAh`],
    ['Mode byte', `0x${info.mode.toString(16).padStart(2, '0')}`],
    ['Protocol byte', `0x${info.protocolByte.toString(16).padStart(2, '0')}`],
    ['Feedback byte', `0x${info.feedbackByte.toString(16).padStart(2, '0')}`],
  ];

  $('toggleProtocol').textContent = info.extendedProtocol
    ? 'Switch to legacy protocol'
    : 'Switch to extended protocol';

  ui.facts.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = String(value);
      row.append(dt, dd);
      return row;
    })
  );

  if (info.voltage < 3.1) {
    setStatus('bad', `Battery is very low at ${info.voltage.toFixed(2)} V`);
  } else if (info.voltage < 3.2) {
    setStatus('warn', `Battery is getting low at ${info.voltage.toFixed(2)} V`);
  }
}

function setCircle(code) {
  ui.circle.classList.toggle('idle', code === null || code === undefined);
  ui.circleText.textContent = code === null || code === undefined ? '–' : String(code);
}

function setStatus(kind, text) {
  ui.status.className = `status ${kind}`.trim();
  ui.status.textContent = text;
}

function setControlsEnabled(enabled) {
  for (const id of [
    'beep', 'syncClock', 'readBackup', 'eraseBackup', 'saveSysval', 'powerOff',
    'detectCard', 'setCode', 'codeInput', 'fbBeeper', 'fbLamp',
    'activeInput', 'setActive', 'toggleProtocol', 'powerOffRemote',
  ]) {
    $(id).disabled = !enabled;
  }
  for (const button of document.querySelectorAll('button.mode')) {
    button.disabled = !enabled;
  }
  for (const radio of document.querySelectorAll('input[name="target"]')) {
    radio.disabled = !enabled;
  }
  for (const radio of document.querySelectorAll('input[name="punchMode"]')) {
    radio.disabled = !enabled;
  }
  $('readRemote').disabled = !enabled;

  ui.disconnect.disabled = !enabled;
  ui.connect.disabled = enabled || !support.any;
  ui.connectUsb.disabled = enabled || !support.webUsb;
  ui.simulate.disabled = enabled;
}

// ------------------------------------------------- operating mode and target

/**
 * Which mode bytes a button stands for.
 *
 * Beacon modes have two encodings -- older stations use 0x12..0x15, newer ones
 * the same values 0x20 higher -- and a button has to light up for either, so
 * matching is done on the byte rather than on the displayed name.
 */
function bytesFor(modeName) {
  const base = MODE_BY_NAME[modeName];
  if (base === undefined) return [];
  const newer = BEACON_OLD_TO_NEW[base];
  return newer === undefined ? [base] : [base, newer];
}

/** Reflect the station's real mode in the button rows. */
function showMode() {
  const mode = station?.mode ?? null;
  $('currentMode').textContent = station?.modeName ?? 'unknown';
  for (const button of document.querySelectorAll('button.mode')) {
    const active = mode !== null && bytesFor(button.dataset.mode).includes(mode);
    button.setAttribute('aria-pressed', String(active));
  }
}

for (const button of document.querySelectorAll('button.mode')) {
  button.addEventListener('click', () =>
    run(async () => {
      const accepted = await station.setOperatingMode(button.dataset.mode);
      showMode();
      await refreshFacts();

      // Beacon modes may land on either encoding; say which the station took.
      const asked = bytesFor(button.dataset.mode)[0];
      const note =
        accepted === asked
          ? ''
          : ` (station wanted the newer 0x${accepted.toString(16)} form)`;
      write('tx', `mode is now ${station.modeName}${note}`);
    })
  );
}

/** Move the radio back to where the hardware actually is. */
function showTarget() {
  const current = station?.target ?? 'direct';
  const radio = document.querySelector(`input[name="target"][value="${current}"]`);
  if (radio) radio.checked = true;
}

for (const radio of document.querySelectorAll('input[name="target"]')) {
  radio.addEventListener('change', async () => {
    if (!station) return;
    station.addEventListener('waking', trackWaking);
    try {
      await station.setTarget(radio.value);
      write(
        'tx',
        radio.value === 'remote'
          ? 'commands now go to the station on the coupling stick'
          : 'commands now go to the cabled station'
      );

      // A station on the stick is asleep, and reading it cold would just fail.
      if (radio.value === 'remote') {
        const awake = await station.wake({ signal: wakeAbort() });
        if (!awake) throw new Error('The station on the stick never answered. Is one there?');
        write('rx', 'the remote station is awake');
      }

      // Anything cached describes the other station, so read it again.
      await refreshFacts();
      showMode();
    } catch (error) {
      // A station that cannot relay leaves the radio lying about the target.
      showTarget();
      fail(error);
    } finally {
      station.removeEventListener('waking', trackWaking);
      clearWaking();
      $('cancelWake').hidden = true;
    }
  });
}

/**
 * Show how far along the wake is.
 *
 * A station on the stick takes tens of seconds to rouse -- 11s and 22.8s on
 * the two measured here -- so without this the page looks hung.
 */
function trackWaking(event) {
  const { attempts, elapsed, timeout } = event.detail;
  const bar = ui.progress.firstElementChild;
  ui.progress.hidden = false;
  bar.style.width = `${Math.min(100, Math.round((elapsed / timeout) * 100))}%`;
  setStatus('warn', `Waking the remote station… ${Math.round(elapsed / 1000)}s, ${attempts} tries`);
}

function clearWaking() {
  ui.progress.hidden = true;
  ui.progress.firstElementChild.style.width = '0';
}

$('readRemote').addEventListener('click', () =>
  run(async () => {
    station.addEventListener('waking', trackWaking);
    try {
      const info = await station.withRemote(() => station.readInfo(), { signal: wakeAbort() });
      write(
        'rx',
        `remote station: ${info.modelName}, serial ${info.serialNumber}, ${info.modeName} mode, code ${info.code}`
      );
      showRemoteFacts(info);
      setStatus('live', `Read ${info.modelName} on the coupling stick`);
    } finally {
      station.removeEventListener('waking', trackWaking);
      clearWaking();
      // withRemote has already put us back on the cable.
      showTarget();
    }
  })
);

/** Let the user call off a wake that is going nowhere. */
let wakeController = null;
function wakeAbort() {
  wakeController = new AbortController();
  $('cancelWake').hidden = false;
  return wakeController.signal;
}

$('cancelWake').addEventListener('click', () => {
  wakeController?.abort();
  $('cancelWake').hidden = true;
  write('err', 'wake cancelled');
});

/** The remote station's details, kept apart from the cabled one's. */
function showRemoteFacts(info) {
  const list = $('remoteFacts');
  list.replaceChildren();
  const rows = [
    ['Model', info.modelName],
    ['Serial number', String(info.serialNumber)],
    ['Control code', String(info.code)],
    ['Mode', info.modeName],
    ['Firmware', info.firmware],
    ['Battery', `${info.voltage.toFixed(2)} V`],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    row.append(dt, dd);
    list.append(row);
  }
  $('remotePanel').hidden = false;
}

// ------------------------------------------------------ code, feedback, awake

$('setCode').addEventListener('click', () =>
  run(async () => {
    const code = Number($('codeInput').value);
    await station.setStationCode(code);
    await refreshFacts();
    showFeedback();
    // Read it back rather than echoing what was asked for: codes above 255
    // split across two bytes, so a mismatch here is worth seeing.
    write('tx', `control code is now ${lastInfo?.code ?? code}`);
  })
);

/** Tick boxes reflect the station, and changing one writes it straight away. */
function showFeedback() {
  const info = lastInfo;
  if (!info) return;
  $('fbBeeper').checked = info.audibleFeedback;
  $('fbLamp').checked = info.opticalFeedback;
  $('codeInput').value = String(info.code);
  $('activeInput').value = String(info.activeTimeMinutes);
}

async function applyFeedback() {
  await station.setFeedback({
    audible: $('fbBeeper').checked,
    optical: $('fbLamp').checked,
  });
  await refreshFacts();
  write(
    'tx',
    `feedback: beeper ${$('fbBeeper').checked ? 'on' : 'off'}, ` +
      `lamp ${$('fbLamp').checked ? 'on' : 'off'}`
  );
}

$('fbBeeper').addEventListener('change', () => run(applyFeedback));
$('fbLamp').addEventListener('change', () => run(applyFeedback));

$('setActive').addEventListener('click', () =>
  run(async () => {
    const minutes = Number($('activeInput').value);
    await station.setActiveTime(minutes);
    await refreshFacts();
    write('tx', `stays awake for ${minutes} minutes`);
  })
);

$('toggleProtocol').addEventListener('click', () =>
  run(async () => {
    const toExtended = !lastInfo?.extendedProtocol;
    await station.setExtendedProtocol(toExtended);
    await refreshFacts();
    write('tx', `protocol is now ${toExtended ? 'extended' : 'legacy'}`);
  })
);

$('powerOffRemote').addEventListener('click', () =>
  run(async () => {
    await station.powerOffRemote();
    write('tx', 'sent the switch-off sequence to the remote station');
    setStatus('warn', 'Remote station switched off');
  })
);

// ------------------------------------------------------------- punch handling

/** Reflect the station's protocol bits in the radios. */
function showPunchMode() {
  const autosend = station?.protoConfig?.autoSend ?? false;
  const value = autosend ? 'autosend' : 'readout';
  const radio = document.querySelector(`input[name="punchMode"][value="${value}"]`);
  if (radio) radio.checked = true;
  $('punchModeNote').textContent = autosend
    ? 'Punches arrive as they happen. Card readout is off while this is on.'
    : 'Cards are read when inserted. Live punches are off while this is on.';
}

for (const radio of document.querySelectorAll('input[name="punchMode"]')) {
  radio.addEventListener('change', () =>
    run(async () => {
      // setAutoSend flips handshake to the opposite, which is what the
      // hardware requires -- the two cannot both be on.
      await station.setAutoSend(radio.value === 'autosend');
      showPunchMode();
      write('tx', `punch handling: ${radio.value}`);
    })
  );
}

$('detectCard').addEventListener('click', () =>
  run(async () => {
    const found = await station.detectCard();
    if (found) {
      write('rx', `card ${found.cardNumber} (${found.cardType}) is in the station`);
      setStatus('live', `Reading card ${found.cardNumber}`);
    } else {
      setStatus('warn', 'No card in the station');
      write('rx', 'no card in the station');
    }
  })
);

// ------------------------------------------------------------------- commands

$('beep').addEventListener('click', () => run(() => station.beep(2)));

$('syncClock').addEventListener('click', () =>
  run(async () => {
    await station.setTime(new Date());
    await refreshFacts();
    setStatus('live', 'Clock set from this computer');
  })
);

$('powerOff').addEventListener('click', () =>
  run(async () => {
    await station.powerOff();
    setStatus('warn', 'The station was switched off');
  })
);

$('eraseBackup').addEventListener('click', () =>
  run(async () => {
    if (!confirm('Erase the backup memory? The punches on the station are gone for good.')) return;
    await station.eraseBackup();
    await refreshFacts();
    setStatus('live', 'Backup memory erased');
  })
);

$('readBackup').addEventListener('click', () =>
  run(async () => {
    const bar = ui.progress.firstElementChild;
    ui.progress.hidden = false;
    const punches = await station.readBackup({
      onProgress: (done, total) => {
        bar.style.width = total ? `${Math.round((done / total) * 100)}%` : '100%';
      },
    });
    ui.progress.hidden = true;
    bar.style.width = '0';

    if (punches.length === 0) {
      setStatus('warn', 'The backup memory is empty');
      return;
    }
    const info = await station.readInfo();
    const csv = backupToCsv(punches, {
      code: info.code,
      serialNumber: info.serialNumber,
      mode: info.modeName,
    });
    downloadText(backupFilename(info.code, info.modeName, info.serialNumber), csv);
    setStatus('live', `${punches.length} punches read and saved`);
    showBackup(punches, info);
  })
);

$('saveSysval').addEventListener('click', () =>
  run(async () => {
    await station.refreshSysval();
    downloadText(`${station.stationCode}_configuration.csv`, sysvalToCsv(station.sysval));
  })
);

async function run(task) {
  if (!station) return;
  try {
    await task();
  } catch (error) {
    fail(error);
  }
}

// -------------------------------------------------------------------- results

function addCard(card) {
  readCards.push(card);
  const article = document.createElement('article');
  article.className = 'readout';

  const header = document.createElement('header');
  const number = document.createElement('span');
  number.className = 'number';
  number.textContent = card.cardNumber;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.append(
    document.createTextNode(`${card.cardType} · `),
    strong(`${card.punches.length} punches`),
    document.createTextNode(card.start ? ` · start ${clock(card.start)}` : ''),
    document.createTextNode(card.finish ? ` · finish ${clock(card.finish)}` : '')
  );
  header.append(number, meta);

  const table = document.createElement('table');
  table.innerHTML =
    '<thead><tr><th>#</th><th>Control</th><th>Time</th><th>Split</th></tr></thead>';
  const body = document.createElement('tbody');

  let previous = card.start;
  card.punches.forEach((punch, index) => {
    const row = document.createElement('tr');
    row.append(
      cell(index + 1, 'num'),
      cell(punch.code, 'num'),
      cell(formatTimeOfDay(punch.time)),
      cell(previous ? splitOf(previous, punch.time) : '')
    );
    body.append(row);
    previous = punch.time;
  });

  if (card.finish) {
    const row = document.createElement('tr');
    row.className = 'split-line';
    row.append(
      cell(''),
      cell('Finish'),
      cell(formatTimeOfDay(card.finish)),
      cell(previous ? splitOf(previous, card.finish) : '')
    );
    body.append(row);
  }

  table.append(body);
  article.append(header, table);
  prepend(article);
  ui.resultsHeading.textContent = `Cards read (${readCards.length})`;
  $('exportCards').disabled = false;
  $('clearCards').disabled = false;
}

function addPunch(punch) {
  const line = document.createElement('article');
  line.className = 'readout';
  const header = document.createElement('header');
  const number = document.createElement('span');
  number.className = 'number';
  number.textContent = punch.cardNumber;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent =
    (punch.time ? formatTimeOfDay(punch.time) : 'no time') +
    (punch.recovered ? ' · read back from memory' : '');
  header.append(number, meta);
  line.append(header);
  prepend(line);
}

function showBackup(punches, info) {
  const article = document.createElement('article');
  article.className = 'readout';
  const header = document.createElement('header');
  const number = document.createElement('span');
  number.className = 'number';
  number.textContent = `Control ${info.code}`;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.append(strong(`${punches.length} punches`), document.createTextNode(' from the backup memory'));
  header.append(number, meta);

  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>#</th><th>Card</th><th>Punched</th><th></th></tr></thead>';
  const body = document.createElement('tbody');
  punches.slice(-200).forEach((punch, index) => {
    const row = document.createElement('tr');
    row.append(
      cell(index + 1, 'num'),
      cell(punch.cardNumber, 'num'),
      cell(formatDateTime(punch.time)),
      cell(punch.error)
    );
    body.append(row);
  });
  table.append(body);
  article.append(header, table);
  prepend(article);
}

$('exportCards').addEventListener('click', () => {
  const rows = [];
  for (const card of readCards) {
    for (const [index, punch] of card.punches.entries()) {
      rows.push([
        card.cardNumber,
        card.cardType,
        index + 1,
        punch.code,
        formatDateTime(punch.time),
        card.start ? formatTimeOfDay(card.start) : '',
        card.finish ? formatTimeOfDay(card.finish) : '',
      ]);
    }
  }
  downloadText(
    `cards_${new Date().toISOString().slice(0, 10)}.csv`,
    rowsToCsv(
      ['SIID', 'Card type', 'Punch no', 'Control', 'Punch time', 'Start', 'Finish'],
      rows
    )
  );
});

$('clearCards').addEventListener('click', () => {
  readCards = [];
  ui.cards.replaceChildren(emptyState());
  ui.resultsHeading.textContent = 'Cards read';
  $('exportCards').disabled = true;
  $('clearCards').disabled = true;
});

// -------------------------------------------------------------------- helpers

function prepend(node) {
  const empty = ui.cards.querySelector('.empty');
  if (empty) empty.remove();
  ui.cards.prepend(node);
}

function emptyState() {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = 'Put a card in the station and the readout appears here.';
  return p;
}

function cell(text, className = '') {
  const td = document.createElement('td');
  td.textContent = String(text ?? '');
  if (className) td.className = className;
  return td;
}

function strong(text) {
  const el = document.createElement('strong');
  el.textContent = text;
  return el;
}

function clock(date) {
  return formatTimeOfDay(date).slice(0, 8);
}

function splitOf(from, to) {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function write(kind, text) {
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  ui.log.append(line);
  while (ui.log.childElementCount > 400) ui.log.firstElementChild.remove();
  ui.log.scrollTop = ui.log.scrollHeight;
}

function logBytes(kind, bytes) {
  if (!ui.showHex.checked) return;
  write(kind, `${kind === 'tx' ? '-->>' : '<<--'} ${hex(bytes)}`);
}

function fail(error) {
  console.error(error);
  setStatus('bad', error.message ?? String(error));
  write('err', error.message ?? String(error));
}

// A few cards turn up on their own so the simulator has something to show.
function scheduleSimulatedCards() {
  const numbers = [8100999, 1234567, 7654321];
  let i = 0;
  const next = () => {
    if (!simulator) return;
    const base = new Date();
    base.setHours(10, 0, 0, 0);
    const punches = [31, 32, 45, 33, 46, 100].map((code, n) => ({
      code,
      time: new Date(base.getTime() + (n + 1) * (70 + n * 25) * 1000),
    }));
    simulator.insertCard(numbers[i % numbers.length], { punches });
    i += 1;
    setTimeout(() => simulator?.removeCard(), 1200);
    setTimeout(next, 6000);
  };
  setTimeout(next, 600);
}
