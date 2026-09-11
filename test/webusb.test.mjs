// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dulcilubio
// See NOTICE and LICENSE at the repository root.

/**
 * WebUSB transport tests.
 *
 * A fake CP210x device stands in for the hardware: its bulk endpoints are
 * wired to SimulatedTransport, the same fake BSM8 the rest of the suite runs
 * against. So these tests cover both halves -- the vendor control transfers
 * that stand in for the driver, and a real card readout carried over the bulk
 * endpoints.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WebUsbTransport, toTransport, transportSupport } from '../src/index.js';
import { SimulatedTransport } from '../src/simulator.js';
import { SIReadout } from '../src/readout.js';
import { BAUD_HIGH, BAUD_LOW } from '../src/constants.js';

const IFC_ENABLE = 0x00;
const SET_LINE_CTL = 0x03;
const SET_MHS = 0x07;
const SET_BAUDRATE = 0x1e;
const PURGE = 0x12;

/** A CP210x that answers control transfers and pipes bulk traffic to `station`. */
class FakeUsbDevice {
  constructor(station = null) {
    this.station = station;
    this.opened = false;
    this.released = false;
    this.control = [];
    this.configuration = {
      interfaces: [
        {
          interfaceNumber: 0,
          alternate: {
            endpoints: [
              { direction: 'in', type: 'bulk', endpointNumber: 1, packetSize: 64 },
              { direction: 'out', type: 'bulk', endpointNumber: 1, packetSize: 64 },
            ],
          },
        },
      ],
    };
    this.inbox = [];
    this.waiting = [];
    this.gone = false;

    if (station) {
      station.onData = (chunk) => this.#deliver(chunk);
      station.open();
    }
  }

  /** Hand bytes to the host, waking a parked read if there is one. */
  push(chunk) {
    this.#deliver(chunk);
  }

  #deliver(chunk) {
    const next = this.waiting.shift();
    if (next) next.resolve({ status: 'ok', data: toDataView(chunk) });
    else this.inbox.push(chunk);
  }

  async open() {
    this.opened = true;
  }
  async selectConfiguration() {}
  async claimInterface() {}
  async releaseInterface() {
    this.released = true;
    this.#abortPending();
  }
  async close() {
    this.opened = false;
    this.#abortPending();
  }

  /** Releasing the interface must reject transfers that are still parked. */
  #abortPending() {
    this.gone = true;
    for (const w of this.waiting.splice(0)) {
      w.reject(new Error('the device was released'));
    }
  }

  async controlTransferOut(setup, data) {
    this.control.push({ ...setup, data: data ? new Uint8Array(data) : null });
    return { status: 'ok' };
  }

  async transferOut(endpointNumber, data) {
    assert.equal(endpointNumber, 1);
    if (this.station) await this.station.write(new Uint8Array(data));
    return { status: 'ok' };
  }

  async transferIn() {
    if (this.gone) throw new Error('the device was released');
    const ready = this.inbox.shift();
    if (ready) return { status: 'ok', data: toDataView(ready) };
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }
}

function toDataView(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

const findControl = (dev, request) => dev.control.filter((c) => c.request === request);

test('opening drives the CP210x through the sequence a driver would', async () => {
  const device = new FakeUsbDevice();
  const transport = new WebUsbTransport(device);
  await transport.open({ baudRate: BAUD_HIGH });

  assert.equal(device.opened, true, 'the device is opened');
  assert.equal(transport.isOpen, true);

  // Every request goes to the interface as a vendor request, not to the device.
  for (const c of device.control) {
    assert.equal(c.requestType, 'vendor');
    assert.equal(c.recipient, 'interface');
  }

  const order = device.control.map((c) => c.request);
  assert.deepEqual(
    order,
    [IFC_ENABLE, SET_BAUDRATE, SET_LINE_CTL, SET_MHS, PURGE],
    'the UART is enabled before it is configured, and flushed last'
  );

  assert.equal(findControl(device, IFC_ENABLE)[0].value, 0x0001, 'UART enabled');
  assert.equal(findControl(device, SET_LINE_CTL)[0].value, 0x0800, '8 data bits, no parity, 1 stop');
  assert.equal(findControl(device, SET_MHS)[0].value, 0x0303, 'DTR and RTS asserted');

  await transport.close();
});

test('the baud rate travels as a little-endian 32-bit payload', async () => {
  const device = new FakeUsbDevice();
  const transport = new WebUsbTransport(device);
  await transport.open({ baudRate: BAUD_HIGH });

  const [setBaud] = findControl(device, SET_BAUDRATE);
  assert.equal(setBaud.value, 0, 'the rate is not in wValue');
  assert.deepEqual(
    Array.from(setBaud.data),
    [0x00, 0x96, 0x00, 0x00],
    '38400 == 0x9600, little endian'
  );

  await transport.close();
});

test('changing speed is one control transfer, with no reconnect', async () => {
  const device = new FakeUsbDevice();
  const transport = new WebUsbTransport(device);
  await transport.open({ baudRate: BAUD_HIGH });

  await transport.setBaudRate(BAUD_LOW);

  const rates = findControl(device, SET_BAUDRATE);
  assert.equal(rates.length, 2, 'a second SET_BAUDRATE went out');
  assert.deepEqual(Array.from(rates[1].data), [0xc0, 0x12, 0x00, 0x00], '4800 == 0x12c0');
  assert.equal(transport.baudRate, BAUD_LOW);
  assert.equal(transport.isOpen, true, 'the connection stayed up, unlike Web Serial');

  // Setting the same rate again is a no-op.
  await transport.setBaudRate(BAUD_LOW);
  assert.equal(findControl(device, SET_BAUDRATE).length, 2);

  await transport.close();
});

test('bytes arriving on the bulk endpoint reach onData', async () => {
  const device = new FakeUsbDevice();
  const chunks = [];
  const transport = new WebUsbTransport(device, { onData: (c) => chunks.push(Array.from(c)) });
  await transport.open();

  device.push(Uint8Array.of(1, 2, 3));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(chunks[0], [1, 2, 3]);

  await transport.close();
});

test('closing releases the device instead of hanging on a parked read', async () => {
  const device = new FakeUsbDevice();
  let closed = false;
  const transport = new WebUsbTransport(device, { onClose: () => (closed = true) });
  await transport.open();

  // The read loop is now parked inside transferIn with nothing to deliver.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(device.waiting.length, 1, 'a read really is outstanding');

  // If close() awaited the loop before releasing, this would never settle.
  await Promise.race([
    transport.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('close() deadlocked')), 1000)),
  ]);

  assert.equal(transport.isOpen, false);
  assert.equal(device.released, true, 'the interface was released');
  assert.equal(closed, true, 'onClose fired');

  // The UART is parked while the interface is still held.
  const disable = findControl(device, IFC_ENABLE).at(-1);
  assert.equal(disable.value, 0x0000, 'the UART was disabled on the way out');
});

test('end to end: a card is read over WebUSB', async () => {
  const sim = new SimulatedTransport({ latency: 0 });
  const device = new FakeUsbDevice(sim);
  const station = new SIReadout(new WebUsbTransport(device), { retries: 0, timeout: 1000 });

  await station.connect();

  const info = await station.readInfo();
  assert.equal(info.modelName, 'BSM8-USB/SRR', 'the station identified itself');
  assert.equal(info.firmware, '656');

  sim.insertCard(8123456);
  const detected = await station.waitForCard({ timeout: 2000 });
  assert.equal(detected.cardNumber, 8123456);

  const card = await station.readCard();
  assert.equal(card.cardNumber, 8123456);
  assert.equal(Array.isArray(card.punches), true);
  assert.equal(card.punches.length > 0, true, 'punches came back');

  await station.disconnect();
});

test('toTransport picks the right wrapper for each source', () => {
  const usb = toTransport(new FakeUsbDevice());
  assert.equal(usb.constructor.name, 'WebUsbTransport');

  // An object already satisfying the interface is passed straight through.
  const sim = new SimulatedTransport();
  assert.equal(toTransport(sim), sim);

  assert.throws(() => toTransport(null), /No port or device/);
});

test('transportSupport reports nothing in a bare Node process', () => {
  const support = transportSupport();
  assert.deepEqual(support, { webSerial: false, webUsb: false, any: false });
});
