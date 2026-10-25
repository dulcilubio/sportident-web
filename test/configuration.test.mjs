import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuration, capabilities, changes, validateConfiguration, applyConfiguration } from '../config/configuration.js';
import { SIStation } from '../src/station.js';
import { SimulatedTransport } from '../src/simulator.js';
import { MODE, O } from '../src/constants.js';

async function setup(t) {
  const sim = new SimulatedTransport({ latency: 0 });
  const station = new SIStation(sim, { retries: 0, timeout: 100 });
  await station.connect();
  t.after(() => station.disconnect());
  const info = await station.readInfo();
  return { sim, station, info, before: configuration(info, station.protoConfig) };
}

test('configuration distinguishes custom protocol bits and preserves them on unrelated writes', async t => {
  const { station, sim } = await setup(t);
  sim.sysval[O.PROTO] &= ~6;
  const info = await station.readInfo();
  const before = configuration(info, station.protoConfig);
  assert.equal(before.transfer, 'custom');
  await applyConfiguration(station, before, { ...before, active: 20 }, { ...info, target: 'direct' });
  assert.equal(station.protoConfig.autoSend, false);
  assert.equal(station.protoConfig.handshake, false);
});

test('Printout requirements are conditional on documented firmware; SIAC code is fixed', () => {
  assert.equal(capabilities('mode:printout', { modelName: 'BS7-P', firmware: '656' }).forcedPrintout, true);
  assert.equal(capabilities('mode:printout', { modelName: 'BS7-P', firmware: '623' }).forcedPrintout, false);
  assert.equal(capabilities('mode:printout', { modelName: 'BS11-BS', firmware: '999' }).forcedPrintout, false);
  assert.equal(capabilities('siac:on').fixedCode, 124);
  assert.equal(capabilities('mode:control').cardReadout, false);
  assert.equal(capabilities('mode:readout').cardReadout, true);
  assert.equal(capabilities('mode:printout').backup, false);
});

test('apply validates before writing and applies reviewed settings on the remote target', async t => {
  const { station, before, info } = await setup(t);
  await station.setRemote();
  const identity = { ...info, target: 'remote' };
  await assert.rejects(applyConfiguration(station, before, { ...before, active: -1 }, identity), /Awake time/);
  const desired = { ...before, mode: 'mode:control', code: 300, transfer: 'autosend', active: 720, audible: false };
  await applyConfiguration(station, before, desired, identity);
  const result = configuration(await station.readInfo(), station.protoConfig);
  assert.deepEqual(changes(desired, result), []);
  assert.equal(station.target, 'remote');
  assert.equal(station.protoConfig.handshake, false);
});

test('apply refuses another station, another target, or externally changed settings', async t => {
  const { station, before, info } = await setup(t);
  const desired = { ...before, code: 77 };
  await assert.rejects(applyConfiguration(station, before, desired, { ...info, target: 'remote' }), /selected station changed/);
  await assert.rejects(applyConfiguration(station, before, desired, { ...info, serialNumber: -1, target: 'direct' }), /selected station changed/);
  await station.setActiveTime(60);
  await assert.rejects(applyConfiguration(station, before, desired, { ...info, target: 'direct' }), /settings changed/);
  assert.equal((await station.readInfo()).code, info.code);
});

test('partial write failures report completed writes and do not continue', async t => {
  const { station, before, info } = await setup(t);
  const done = [];
  station.setActiveTime = async () => { throw new Error('Lost station'); };
  await assert.rejects(applyConfiguration(station, before,
    { ...before, code: 88, active: 30, transfer: 'autosend' },
    { ...info, target: 'direct' }, label => done.push(label)), /Lost station/);
  assert.deepEqual(done, ['Control code']);
  assert.equal((await station.readInfo()).code, 88);
  assert.equal(station.protoConfig.autoSend, false);
});

test('invalid printout combination is rejected; existing unsupported configuration remains editable', () => {
  const before = { mode: 'mode:printout', transfer: 'handshake', extended: false, code: 31, active: 240, audible: true, optical: true };
  const info = { modelName: 'BS7-P', firmware: '656' };
  assert.equal(validateConfiguration(before, { ...before, active: 30 }, info), '');
  assert.match(validateConfiguration(before, { ...before, transfer: 'autosend' }, info), /Printout requires/);
});
