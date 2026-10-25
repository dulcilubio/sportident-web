// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2008-2023 Gaudenz Steinlin, Simon Harston, Jan Vorwerk,
//                         Per Magnusson (sireader2.py)
// Copyright (C) 2026 dulcilubio (JavaScript port)
// See NOTICE and LICENSE at the repository root.

/**
 * Configuration tool for SPORTident stations and cards.
 *
 * Serve this folder over http (Web Serial and WebUSB need a secure context,
 * and module imports do not work from file://):
 *
 *   python3 -m http.server 8080
 *   open http://localhost:8080/config/
 */

import {
  CMD,
  backupFilename,
  fetchSiacBattery,
  isSiacNumber,
  backupToCsv,
  downloadText,
  formatDateTime,
  formatTimeOfDay,
  hex,
  MODE,
  getGrantedStations,
  requestStation,
  rowsToCsv,
  SimulatedTransport,
  SIReadout,
  sysvalToCsv,
  toTransport,
  transportSupport,
} from '../src/index.js';

import { configuration, modeKey, capabilities, modeOptions, fieldLabels, changes, validateConfiguration, applyConfiguration } from './configuration.js';
import { monitorStation } from './heartbeat.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ sections

/**
 * Bring a section forward. The switching itself lives in a plain script in the
 * page, so navigation still works if this module fails to load.
 */
const showTab = (name) => window.showTab?.(name);

/**
 * Wire a handler by element id.
 *
 * Binding straight onto $('someId') means one renamed element throws during
 * module evaluation and takes every later handler with it -- the page then
 * looks fine and does nothing at all. This reports the mismatch and carries
 * on wiring the rest.
 */
function on(id, event, handler) {
  const element = $(id);
  if (!element) {
    console.error(`config: no element #${id} to attach ${event} to`);
    return;
  }
  element.addEventListener(event, handler);
}
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
/**
 * Reopen a station the browser already has permission for.
 *
 * A reload throws away the page and every object in it, the open device
 * included, so the link goes with it. The *permission* survives: both Web
 * Serial and WebUSB will hand back a granted device without asking again, and
 * opening it needs no click. So a reload can pick the station straight back
 * up, which matters when the alternative is an official clicking through a
 * picker in the middle of an event.
 *
 * Only reconnects when exactly one station was granted. With several there is
 * no way to tell which was in use, and silently opening the wrong one is worse
 * than asking.
 */
async function reconnectSilently() {
  let granted;
  try {
    granted = await getGrantedStations();
  } catch {
    return; // no permission API, or the browser refused. Not worth reporting.
  }
  if (granted.length !== 1) return;

  try {
    setStatus('warn', 'Reopening the station this page already has access to…');
    await attach(new SIReadout(toTransport(granted[0])));
  } catch {
    // The station may be unplugged, or held by another tab. Leave the page
    // ready to connect by hand rather than showing an error nobody asked for.
    setStatus('', 'Nothing connected');
  }
}

async function connectWith(prefer) {
  try {
    // RS232 adapters have their own USB IDs, not SPORTident's.
    const source = await requestStation({ prefer, anyPort: prefer === 'serial' });
    await attach(new SIReadout(toTransport(source)));
  } catch (error) {
    if (error?.name === 'NotFoundError') return; // the picker was dismissed
    fail(error);
  }
}

on('connect', 'click', () => connectWith(support.webSerial ? 'serial' : 'usb'));

// Worth its own button because on macOS the serial picker is often empty --
// Apple's driver ignores SPORTident's product id -- while WebUSB still works.
on('connectUsb', 'click', () => connectWith('usb'));

on('simulate', 'click', async () => {
  simulator = new SimulatedTransport({ code: 31, mode: MODE.READOUT });
  await attach(new SIReadout(simulator));
  setStatus('live', 'Simulated station, no hardware attached');
  scheduleSimulatedCards();
});

on('disconnect', 'click', async () => {
  if (operation || monitor?.checking) return;
  if (hasDraft()) {
    showTab('configure');
    setStatus('warn', 'Apply or discard your changes before disconnecting');
    return;
  }
  monitor?.stop();
  monitor = null;
  await station?.disconnect().catch(() => {});
  station = null;
  simulator = null;
  lastInfo = null;
  baseline = null;
  targetReady = false;
  healthy = false;
  setStatus('', 'Nothing connected');
  showDevice(null);
  showTarget();
  batteryExplained = false;
  $('lastRead').textContent = 'Not read yet';
  $('healthState').textContent = 'Disconnected';
  $('lastResponse').textContent = 'Last response: —';
  ui.facts.replaceChildren();
  $('technicalFacts').replaceChildren();
  $('changeSummary').replaceChildren();
  $('draftState').textContent = 'No changes';
  $('configurationError').textContent = '';
  setCircle(null);
  setControlsEnabled();
});

async function attach(next) {
  if (station) return; // A picker or automatic reconnect may have finished first.
  station = next;
  operation = true;
  targetReady = false;
  baseline = null;
  startMonitoring();
  ui.connect.disabled = true;
  ui.connectUsb.disabled = true;
  ui.simulate.disabled = true;
  setStatus('warn', 'Opening the port…');

  station.addEventListener('tx', (e) => logBytes('tx', e.detail.bytes));
  station.addEventListener('rx', (e) => logBytes('rx', e.detail.bytes));
  station.addEventListener('connecting', (e) => {
    const { baudRate, previousBaudRate } = e.detail;
    const message = previousBaudRate
      ? `No reply at ${previousBaudRate} baud; switched to ${baudRate} baud. Trying for up to 30 seconds…`
      : `Connecting at ${baudRate} baud. Trying for up to 30 seconds…`;
    write('tx', message);
    setStatus('warn', message);
  });
  station.addEventListener('error', (e) => fail(e.detail.error));
  station.addEventListener('garbage', (e) => write('err', `dropped: ${e.detail.reason}`));
  station.addEventListener('close', () => {
    targetReady = false;
    healthy = false;
    setStatus('bad', 'The station went away');
    setControlsEnabled();
  });
  station.addEventListener('cardInserted', (e) => {
    if (station.autoRead) setStatus('warn', `Reading card ${e.detail.cardNumber}…`);
    setTimeout(setControlsEnabled, 0);
  });
  station.addEventListener('cardRemoved', () => setStatus('live', 'Ready for the next card'));
  station.addEventListener('card', (e) => { addCard(e.detail); setTimeout(setControlsEnabled, 0); });
  station.addEventListener('cardError', (e) => { fail(e.detail.error); setTimeout(setControlsEnabled, 0); });
  station.addEventListener('punch', (e) => addPunch(e.detail));

  try {
    await station.connect({ handshakeRetries: 14 });
    await refreshFacts();
    showTarget();
    setStatus('live', 'Connected and listening');
  } catch (error) {
    await station.disconnect().catch(() => {});
    fail(error);
    monitor?.stop();
    station = null;
    targetReady = false;
  } finally {
    operation = false;
    setControlsEnabled();
  }
}

// -------------------------------------------------------------- station panel

let lastInfo = null;
let baseline = null;
let baselineIdentity = null;
let targetReady = false;
let operation = false;
let monitor = null;
let healthy = false;
let monitoringPaused = false;
let wakeController = null;

function showDevice(info) {
  $('deviceName').textContent = info?.modelName ?? 'No station';
  $('deviceDetail').textContent = info ? `#${info.serialNumber} · code ${info.code} · ${info.modeName}` : 'nothing read';
  $('targetIdentity').textContent = info ? `${info.modelName} · #${info.serialNumber}` : 'Station not read';
}

function showTarget() {
  const target = station?.target ?? 'direct';
  for (const radio of document.querySelectorAll('input[name="target"]')) radio.checked = radio.value === target;
  $('targetDescription').textContent = target === 'remote' ? 'Remote: the station on the coupling stick' : 'Direct: the station connected by cable';
}

function renderFacts(id, rows) {
  $(id).replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = String(value);
    row.append(dt, dd);
    return row;
  }));
}

async function refreshFacts({ resetDraft = false } = {}) {
  if (!station) return;
  const info = await station.readInfo();
  const offset = await station.getClockOffset();
  lastInfo = info;
  station.autoRead = info.mode === MODE.READOUT && info.extendedProtocol;
  targetReady = true;
  healthy = true;
  showDevice(info);
  showTarget();
  setCircle(info.code);
  const clock = offset === null ? 'unreadable' : `${(offset / 1000).toFixed(2)} s`;
  $('clockDifference').textContent = `Clock difference: ${clock}`;
  $('lastRead').textContent = `Last read: ${new Date().toLocaleTimeString()}`;
  renderFacts('facts', [
    ['Operating mode', info.modeName], ['Control code', info.code],
    ['Model', info.modelName], ['Serial number', info.serialNumber], ['Firmware', info.firmware],
    ['Battery', `${info.voltage.toFixed(2)} V`], ['Battery used', `${info.batteryUsedPercent.toFixed(1)} %`],
    ['Memory', `${info.memorySizeKb} kB${info.memoryOverflow ? ' (full)' : ''}`],
    ['Awake time', info.activeTime], ['Protocol', info.extendedProtocol ? 'Extended' : 'Legacy'],
    ['Auto-send', info.autoSend ? 'On' : 'Off'], ['Handshake', station.protoConfig.handshake ? 'On' : 'Off'],
    ['Clock difference', clock], ['Beeps on punch', info.audibleFeedback ? 'Yes' : 'No'],
    ['Flashes on punch', info.opticalFeedback ? 'Yes' : 'No'],
  ]);
  renderFacts('technicalFacts', [
    ['Built', info.buildDate], ['Battery fitted', info.batteryDate], ['Battery capacity', `${info.batteryCapacityMah} mAh`],
    ...[['Mode byte', info.mode], ['Protocol byte', info.protocolByte], ['Feedback byte', info.feedbackByte]]
      .map(([label, value]) => [label, `0x${value.toString(16).padStart(2, '0')}`]),
  ]);
  if (resetDraft || !baseline) {
    baseline = configuration(info, station.protoConfig);
    baselineIdentity = { ...info, target: station.target };
    fillForm(baseline);
  }
  updateConfiguration();
  if (info.voltage < 3.2) setStatus('warn', `Battery is low at ${info.voltage.toFixed(2)} V`);
}

function setCircle(code) {
  ui.circle.classList.toggle('idle', code == null);
  ui.circleText.textContent = code == null ? '–' : String(code);
}
function setStatus(kind, text) {
  ui.status.className = `status ${kind}`.trim();
  ui.status.textContent = text;
}
function updateHealth({ healthy: responding, lastResponse }) {
  healthy = responding;
  $('healthState').textContent = responding ? 'Station responding' : 'Station not responding';
  $('healthState').dataset.health = responding ? 'good' : 'bad';
  $('lastResponse').textContent = `Last response: ${lastResponse ? lastResponse.toLocaleTimeString() : '—'}`;
  setControlsEnabled();
}
function startMonitoring() {
  monitor?.stop();
  monitoringPaused = false;
  monitor = monitorStation(station, {
    isIdle: () => !operation && !monitoringPaused,
    onStatus: updateHealth,
    onBusyChange: () => setControlsEnabled(),
  });
}

function readForm() {
  return {
    mode: $('modeSelect').value, code: $('codeInput').value === '' ? NaN : Number($('codeInput').value),
    transfer: $('transferSelect').value, extended: $('extendedProtocol').checked,
    audible: $('fbBeeper').checked, optical: $('fbLamp').checked,
    active: $('activeInput').value === '' ? NaN : Number($('activeInput').value),
  };
}
function fillForm(value) {
  const select = $('modeSelect');
  select.querySelectorAll('option[data-unknown]').forEach(o => o.remove());
  if (![...select.options].some(o => o.value === value.mode)) {
    const option = document.createElement('option');
    option.value = value.mode;
    option.textContent = `Reported mode: ${lastInfo?.modeName ?? value.mode}`;
    option.dataset.unknown = 'true';
    select.append(option);
  }
  select.value = value.mode;
  $('codeInput').value = value.code;
  $('transferSelect').value = value.transfer;
  $('extendedProtocol').checked = value.extended;
  $('fbBeeper').checked = value.audible;
  $('fbLamp').checked = value.optical;
  $('activeInput').value = value.active;
}
function hasDraft() {
  return baseline && changes(baseline, readForm()).length > 0;
}
function valueLabel(key, value) {
  if (key === 'mode') return modeOptions.find(o => o.key === value)?.label ?? value;
  if (key === 'transfer') return { handshake: 'Handshake; auto-send off', autosend: 'Auto-send; handshake off', custom: 'Reported custom combination' }[value];
  return typeof value === 'boolean' ? (value ? 'On' : 'Off') : String(value);
}

function updateConfiguration() {
  if (!baseline) { setControlsEnabled(); return; }
  const draft = readForm();
  const rules = capabilities(draft.mode, lastInfo);
  $('modeNote').textContent = rules.note;
  $('codeNote').textContent = rules.codeEditable ? '1 to 1023' : 'Fixed by the SIAC function.';
  $('transferNote').textContent = rules.forcedPrintout ? 'Auto-send is required by this firmware.'
    : draft.transfer === 'custom' ? 'This station reports a different combination of protocol bits. It is preserved unless you choose a new data-transfer setting.'
    : rules.cardReadout ? (draft.extended ? 'Complete card readout is available in this app.' : 'Enable extended protocol to read cards in this app.')
    : 'This does not enable complete card readout. Auto-send output depends on the mode and hardware. Remote stations may need SRR hardware for live data.';
  const pending = changes(baseline, draft);
  $('draftState').textContent = pending.length ? `${pending.length} pending change${pending.length === 1 ? '' : 's'} — ${$('targetIdentity').textContent}` : 'No changes';
  $('changeSummary').replaceChildren(...pending.map(key => {
    const item = document.createElement('li');
    item.textContent = `${fieldLabels[key]}: ${valueLabel(key, baseline[key])} → ${valueLabel(key, draft[key])}`;
    return item;
  }));
  $('configurationError').textContent = validateConfiguration(baseline, draft, lastInfo);
  setControlsEnabled();
}

function setControlsEnabled() {
  const connected = !!station?.isOpen;
  const idle = connected && !operation && !monitor?.checking && !station?.busy;
  const enabled = idle && targetReady && healthy && !monitoringPaused;
  const draft = baseline ? readForm() : null;
  const rules = capabilities(draft?.mode ?? '', lastInfo ?? {});
  for (const id of ['modeSelect', 'codeInput', 'fbBeeper', 'fbLamp', 'activeInput', 'extendedProtocol', 'transferSelect',
    'beep', 'syncClock', 'saveSysval', 'powerOff', 'eraseBackup']) $(id).disabled = !enabled;
  $('codeInput').disabled = !enabled || !rules.codeEditable;
  $('transferSelect').disabled = !enabled || (rules.forcedPrintout && draft?.transfer === 'autosend');
  $('transferSelect').querySelector('[value="handshake"]').disabled = rules.forcedPrintout;
  $('extendedProtocol').disabled = !enabled || (rules.forcedPrintout && draft?.extended);
  $('applyChanges').disabled = !enabled || !hasDraft() || !!validateConfiguration(baseline, draft, lastInfo);
  $('discardChanges').disabled = operation || !hasDraft();
  $('refreshOverview').disabled = !idle;
  const actual = capabilities(lastInfo ? modeKey(lastInfo) : '', lastInfo ?? {});
  $('detectCard').disabled = !enabled || !actual.cardReadout || !lastInfo?.extendedProtocol || !!lastInfo?.autoSend;
  $('readBackup').disabled = !enabled || !actual.backup;
  $('backupNote').textContent = actual.backup ? 'Read and download recorded punches from the selected station.' : 'Backup punch decoding is unavailable for this operating mode.';
  $('dataWorkflow').textContent = !lastInfo ? 'Read the selected station to see its data workflow.'
    : !lastInfo.extendedProtocol ? 'Legacy protocol: live data decoding is unavailable in this app. Existing results remain below.'
    : actual.cardReadout ? (lastInfo.autoSend ? 'Auto-send card data appears here. Existing results are retained.' : 'Insert a card, or read the card already in the station.')
    : 'Received live punches appear here when the station emits them. Complete card readout requires Readout mode. Existing results are retained.';
  for (const radio of document.querySelectorAll('input[name="target"]')) {
    radio.disabled = !idle || (radio.value === 'remote' && station?.target === 'direct' && lastInfo && !lastInfo.extendedProtocol);
    radio.title = radio.value === 'remote' && station?.target === 'direct' && lastInfo && !lastInfo.extendedProtocol
      ? 'Enable extended protocol on the cabled station to use Remote.' : '';
  }
  ui.disconnect.disabled = !station || operation || !!monitor?.checking;
  ui.connect.disabled = !!station || !support.any;
  ui.connectUsb.disabled = !!station || !support.webUsb;
  ui.simulate.disabled = !!station;
}

on('configurationForm', 'input', (event) => {
  if (!baseline) return;
  if (event.target.id === 'modeSelect') {
    const rule = capabilities($('modeSelect').value, lastInfo);
    if (rule.fixedCode != null) $('codeInput').value = rule.fixedCode;
    if (rule.forcedPrintout) {
      $('transferSelect').value = 'autosend';
      $('extendedProtocol').checked = true;
    }
  }
  updateConfiguration();
});
on('discardChanges', 'click', () => {
  if (!baseline) return;
  if (lastInfo && targetReady) {
    baseline = configuration(lastInfo, station.protoConfig);
    baselineIdentity = { ...lastInfo, target: station.target };
  }
  fillForm(baseline);
  updateConfiguration();
});
on('configurationForm', 'submit', (event) => {
  event.preventDefault();
  run(async () => {
    const desired = readForm();
    const identity = baselineIdentity;
    const expected = changes(baseline, desired);
    const applied = [];
    let failure;
    station.autoRead = false;
    try {
      await applyConfiguration(station, baseline, desired, identity, label => applied.push(label));
    } catch (error) { failure = error; }
    try {
      await refreshFacts({ resetDraft: true });
    } catch (error) {
      targetReady = false;
      throw new Error(`Could not read back settings. ${applied.length ? `Completed: ${applied.join(', ')}. ` : ''}Refresh before applying again. ${failure?.message ?? error.message}`);
    }
    if (lastInfo.serialNumber !== identity.serialNumber || station.target !== identity.target) {
      throw new Error('The station changed. Its current settings have been loaded; the previous station’s draft was not carried over.');
    }
    const mismatches = expected.filter(key => baseline[key] !== desired[key]);
    if (failure || mismatches.length) {
      fillForm(desired);
      updateConfiguration();
      throw new Error(`${failure?.message ?? `Station did not accept: ${mismatches.map(k => fieldLabels[k]).join(', ')}.`} ${applied.length ? `Completed writes: ${applied.join(', ')}. ` : ''}Actual values are in Overview; remaining changes are kept for review.`);
    }
    setStatus('live', 'Changes applied and read back from the station');
  });
});

on('refreshOverview', 'click', () => run(async () => {
  if (monitoringPaused) { monitoringPaused = false; startMonitoring(); }
  if (station.target === 'remote' && !targetReady) await wakeSelected();
  await refreshFacts({ resetDraft: !hasDraft() });
  setStatus('live', 'Station settings refreshed');
}, { requireReady: false }));

for (const radio of document.querySelectorAll('input[name="target"]')) {
  radio.addEventListener('change', () => {
    const target = radio.value;
    if (hasDraft()) {
      showTarget();
      showTab('configure');
      setStatus('warn', 'Apply or discard your changes before switching stations');
      return;
    }
    run(async () => {
      monitor?.stop();
      targetReady = false;
      healthy = false;
      lastInfo = null;
      baseline = null;
      showDevice(null);
      ui.facts.replaceChildren();
      $('technicalFacts').replaceChildren();
      $('lastRead').textContent = 'Reading selected station…';
      $('lastResponse').textContent = 'Last response: —';
      $('healthState').textContent = 'Reading selected station…';
      station.autoRead = false;
      try {
        await station.setTarget(target);
        if (target === 'remote') await wakeSelected();
        await refreshFacts({ resetDraft: true });
        setStatus('live', 'Selected station read and ready');
      } finally {
        showTarget();
        startMonitoring();
        if (targetReady) updateHealth({ healthy: true, lastResponse: new Date() });
        else {
          $('lastRead').textContent = 'Station not read — refresh or switch target';
          updateHealth({ healthy: false, lastResponse: null });
        }
        station.autoRead = targetReady && lastInfo?.mode === MODE.READOUT && lastInfo.extendedProtocol;
      }
    }, { requireReady: false });
  });
}

function trackWaking(event) {
  const { attempts, elapsed, timeout } = event.detail;
  ui.progress.hidden = false;
  ui.progress.firstElementChild.style.width = `${Math.min(100, Math.round(elapsed / timeout * 100))}%`;
  setStatus('warn', `Waking remote station… ${Math.round(elapsed / 1000)}s, ${attempts} tries`);
}
async function wakeSelected() {
  wakeController = new AbortController();
  $('cancelWake').hidden = false;
  station.addEventListener('waking', trackWaking);
  try {
    if (!await station.wake({ signal: wakeController.signal })) throw new Error('Remote station did not answer. Check the coupling stick and refresh.');
    if (wakeController.signal.aborted) throw new Error('Remote wake cancelled. Refresh to read the station.');
  } finally {
    station.removeEventListener('waking', trackWaking);
    $('cancelWake').hidden = true;
    ui.progress.hidden = true;
    wakeController = null;
  }
}
on('cancelWake', 'click', () => wakeController?.abort());

on('detectCard', 'click', () =>
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



// ------------------------------------------------------------- siac battery

/** Fill in a card's battery note once SPORTident answer. */
async function showBattery(cardNumber, note) {
  try {
    const battery = await fetchSiacBattery(cardNumber, { timeout: 6000 });
    if (!battery) {
      note.textContent = ' · battery date unknown';
      return;
    }

    const due = battery.replaceBefore ? battery.replaceBefore.toLocaleDateString() : 'unknown';
    const wording = {
      ok: `battery good until ${due}`,
      due: `battery due ${due}`,
      overdue: `battery overdue since ${due}`,
      unknown: 'battery date unknown',
    };
    note.textContent = ` · ${wording[battery.status]}`;
    note.dataset.status = battery.status;
    write('rx', `card ${cardNumber}: ${wording[battery.status]}`);
  } catch (error) {
    // Offline, or an origin the API will not talk to. Neither is worth a red
    // error over a card that read perfectly well, but the two have different
    // fixes, so say which is the likely one rather than leaving it a mystery.
    note.textContent = ' · battery not checked';
    note.title = error.message;
    explainBatteryFailure();
  }
}

/**
 * Say once why the lookup did not happen.
 *
 * A browser reports a blocked cross-origin request exactly like a dead
 * network, so this cannot be certain. Being offline is knowable, though, and
 * whichever it is has a different fix: wait for signal, or get the page's
 * origin allowed by SPORTident.
 */
let batteryExplained = false;
function explainBatteryFailure() {
  if (batteryExplained) return;
  batteryExplained = true;

  const offline = !navigator.onLine;
  write(
    'err',
    offline
      ? 'SIAC battery lookup skipped: no network. Cards and stations are unaffected.'
      : `SIAC battery lookup blocked for this page (${window.location.origin}). ` +
          'SPORTident only answer browsers on origins they have allowed. Ask them to ' +
          'add this one, or call the API from your own server and pass baseUrl. ' +
          'Cards and stations are unaffected.'
  );
}

// ------------------------------------------------------------------- commands

on('beep', 'click', () => run(() => station.beep(2)));

on('syncClock', 'click', () =>
  run(async () => {
    await station.setTime(new Date());
    await refreshFacts();
    setStatus('live', 'Clock set from this computer');
  })
);

on('powerOff', 'click', () =>
  run(async () => {
    monitoringPaused = true;
    monitor?.stop();
    station.autoRead = false;
    $('healthState').textContent = 'Switching off · monitoring paused';
    await station.sendCommand(CMD.OFF, [], { retries: 0 });
    $('healthState').textContent = 'Switched off · monitoring paused';
    setStatus('warn', 'Selected station switched off. Refresh to reconnect.');
  })
);

on('eraseBackup', 'click', () =>
  run(async () => {
    if (!confirm('Erase the backup memory? The punches on the station are gone for good.')) return;
    await station.eraseBackup();
    await refreshFacts();
    setStatus('live', 'Backup memory erased');
  })
);

on('readBackup', 'click', () =>
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

on('saveSysval', 'click', () =>
  run(async () => {
    await station.refreshSysval();
    downloadText(`${station.stationCode}_configuration.csv`, sysvalToCsv(station.sysval));
  })
);

async function run(task, { requireReady = true } = {}) {
  if (!station || operation || monitor?.checking || station.busy || station.isCommunicating) return;
  if (requireReady && (!targetReady || !healthy || monitoringPaused)) return;
  operation = true;
  setControlsEnabled();
  try {
    await task();
  } catch (error) {
    fail(error);
    if (!$('panel-configure').hidden) $('configurationError').textContent = error.message;
  } finally {
    operation = false;
    ui.progress.hidden = true;
    setControlsEnabled();
  }
}

// -------------------------------------------------------------------- results

function addCard(card) {
  readCards.push(card);
  if (!hasDraft() && !operation) showTab('cards');
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
    document.createTextNode(card.check ? ` · check ${clock(card.check)}` : ''),
    document.createTextNode(card.start ? ` · start ${clock(card.start)}` : ''),
    document.createTextNode(card.finish ? ` · finish ${clock(card.finish)}` : '')
  );
  header.append(number, meta);

  // A SIAC carries no battery date of its own, so it has to be looked up.
  // Never let that hold up showing the card, and never let it fail loudly.
  if (isSiacNumber(card.cardNumber) && $('checkBattery').checked) {
    const note = document.createElement('span');
    note.className = 'meta battery';
    note.textContent = ' · checking battery…';
    header.append(note);
    showBattery(card.cardNumber, note);
  }

  const table = document.createElement('table');
  table.innerHTML =
    '<thead><tr><th>#</th><th>Control</th><th>Time</th><th>Split</th></tr></thead>';
  const body = document.createElement('tbody');

  /**
   * The stations a runner passes before the course itself.
   *
   * Clear and check are what prove the card was emptied and armed, so they
   * matter when a run is queried, and a SIAC only switches its beacon on at
   * check. Worth showing rather than leaving decoded but invisible.
   */
  for (const [label, time, code] of [
    ['Clear', card.clear, card.clearCode],
    ['Check', card.check, card.checkCode],
    ['Start', card.start, card.startCode],
  ]) {
    if (!time) continue;
    const row = document.createElement('tr');
    row.className = 'pre-start';
    row.append(
      cell(''),
      cell(code === null || code === undefined ? label : `${label} (${code})`),
      cell(formatTimeOfDay(time)),
      cell('')
    );
    body.append(row);
  }

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

  // A live punch carries a card number too, so the same battery note applies.
  if (isSiacNumber(punch.cardNumber) && $('checkBattery').checked) {
    const note = document.createElement('span');
    note.className = 'meta battery';
    note.textContent = ' · checking battery…';
    header.append(note);
    showBattery(punch.cardNumber, note);
  }
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

  // No battery note here: a backup listing is about the station and the many
  // cards that passed it, not about one card.

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

on('exportCards', 'click', () => {
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

on('clearCards', 'click', () => {
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

// All state and event handlers are ready before reconnecting.
setControlsEnabled();
reconnectSilently();
