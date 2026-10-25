// SPDX-License-Identifier: GPL-3.0-or-later
import { MODE, MODE_BY_NAME, MODE_NAMES, BEACON_OLD_TO_NEW, SIAC_FUNCTIONS,
  SIAC_MODES, SUPPORTED_READ_BACKUP_MODES } from '../src/constants.js';

export function modeKey(info) {
  const special = SIAC_FUNCTIONS.find(f => f.mode === info.mode && f.code === info.code);
  if (special) return `siac:${special.key}`;
  const entry = Object.entries(MODE_BY_NAME).find(([, value]) =>
    value === info.mode || BEACON_OLD_TO_NEW[value] === info.mode);
  return entry ? `mode:${entry[0]}` : `raw:${info.mode}`;
}

export function configuration(info, proto) {
  return {
    mode: modeKey(info), code: info.code,
    transfer: proto.autoSend && !proto.handshake ? 'autosend'
      : !proto.autoSend && proto.handshake ? 'handshake' : 'custom',
    extended: info.extendedProtocol,
    audible: info.audibleFeedback, optical: info.opticalFeedback,
    active: info.activeTimeMinutes,
  };
}

export function capabilities(key, info = {}) {
  const [kind, name] = key.split(':');
  const special = kind === 'siac' ? SIAC_FUNCTIONS.find(f => f.key === name) : null;
  const mode = special?.mode ?? (kind === 'raw' ? Number(name) : MODE_BY_NAME[name]);
  const fixedCode = special?.code;
  const printout = mode === MODE.PRINTOUT;
  // SPORTident BS7/8/9 firmware release 649: Printout forces auto-send and extended.
  const forcedPrintout = printout && /^BS[FM]?[789]\b/.test(info.modelName ?? '') && Number(info.firmware) >= 649;
  return {
    mode, fixedCode,
    codeEditable: !SIAC_MODES.includes(mode),
    cardReadout: mode === MODE.READOUT,
    backup: SUPPORTED_READ_BACKUP_MODES.includes(mode),
    forcedPrintout,
    note: special ? 'The function determines the control code. Data output depends on the station and function.'
      : printout ? (forcedPrintout ? 'This firmware requires auto-send and extended protocol for Printout.'
        : 'Printout behavior depends on the printer station and firmware; this app does not print receipts.')
      : mode === MODE.READOUT ? 'Handshake reads cards on insertion. Auto-send receives complete card data. Both need extended protocol in this app.'
      : 'Auto-send is configurable on cabled stations. The data emitted depends on the mode and hardware; this app does not read complete cards in this mode.',
  };
}

export const modeOptions = [
  ...Object.entries(MODE_BY_NAME).map(([key, value]) => ({ key: `mode:${key}`, label: MODE_NAMES[value] })),
  ...SIAC_FUNCTIONS.map(f => ({ key: `siac:${f.key}`, label: f.name })),
];

export const fieldLabels = {
  mode: 'Operating mode', code: 'Control code', transfer: 'Data transfer',
  extended: 'Extended protocol', audible: 'Beep', optical: 'Flash', active: 'Awake time (minutes)',
};
export function changes(before, after) {
  return Object.keys(fieldLabels).filter(key => before[key] !== after[key]);
}

export function validateConfiguration(before, draft, info) {
  const changed = changes(before, draft);
  const rules = capabilities(draft.mode, info);
  if (changed.includes('mode') && !modeOptions.some(o => o.key === draft.mode)) return 'Choose a supported operating mode.';
  if (changed.includes('code') && (!Number.isInteger(draft.code) || draft.code < 1 || draft.code > 1023)) return 'Control code must be an integer from 1 to 1023.';
  if (!rules.codeEditable && draft.code !== (rules.fixedCode ?? before.code)) return 'This SIAC function determines its control code.';
  if (changed.includes('active') && (!Number.isInteger(draft.active) || draft.active < 0 || draft.active > 5759)) return 'Awake time must be an integer from 0 to 5759 minutes.';
  if (changed.includes('transfer') && !['handshake', 'autosend'].includes(draft.transfer)) return 'Choose handshake or auto-send.';
  if (rules.forcedPrintout && changed.some(k => ['mode', 'transfer', 'extended'].includes(k)) &&
      (draft.transfer !== 'autosend' || !draft.extended)) return 'Printout requires auto-send and extended protocol on this firmware.';
  return '';
}

/** Write only the reviewed changes. Never move a draft to a different station. */
export async function applyConfiguration(station, before, draft, identity, onApplied = () => {}) {
  const error = validateConfiguration(before, draft, identity);
  if (error) throw new Error(error);
  const fresh = await station.readInfo();
  if (fresh.serialNumber !== identity.serialNumber || station.target !== identity.target) {
    throw new Error('The selected station changed. Read its settings before applying changes.');
  }
  const current = configuration(fresh, station.protoConfig);
  if (changes(before, current).length) throw new Error('Station settings changed since they were read. Review the refreshed values before applying.');
  const changed = changes(before, draft);
  async function step(key, task) {
    await task();
    onApplied(fieldLabels[key]);
  }
  // Enable extended first; disable it last so all other writes use the working protocol.
  if (changed.includes('extended') && draft.extended) await step('extended', () => station.setExtendedProtocol(true));
  if (changed.includes('mode')) {
    const [kind, key] = draft.mode.split(':');
    await step('mode', () => kind === 'siac' ? station.setSiacFunction(key) : station.setOperatingMode(key));
  }
  const rules = capabilities(draft.mode, fresh);
  if (changed.includes('code') && rules.codeEditable) await step('code', () => station.setStationCode(draft.code));
  if (changed.includes('audible') || changed.includes('optical')) {
    await step('audible', () => station.setFeedback({ audible: draft.audible, optical: draft.optical }));
  }
  if (changed.includes('active')) await step('active', () => station.setActiveTime(draft.active));
  if (changed.includes('transfer')) await step('transfer', () => station.setAutoSend(draft.transfer === 'autosend'));
  if (changed.includes('extended') && !draft.extended) await step('extended', () => station.setExtendedProtocol(false));
}
