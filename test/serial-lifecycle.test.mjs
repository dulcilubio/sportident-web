import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSerialTransport } from '../src/transport.js';

function serialPort() {
  return {
    opened: false,
    closes: 0,
    async open() {
      if (this.opened) throw new DOMException('Already open', 'InvalidStateError');
      this.opened = true;
      this.readable = new ReadableStream();
      this.writable = new WritableStream();
    },
    async setSignals() {},
    async close() {
      assert.equal(this.readable.locked, false);
      assert.equal(this.writable.locked, false);
      this.opened = false;
      this.closes++;
    },
  };
}

test('baud switches and reconnects release both serial stream locks', async () => {
  const port = serialPort();
  const transport = new WebSerialTransport(port);
  await transport.open();
  const { readable, writable } = port;
  await transport.setBaudRate(4800);
  assert.equal(readable.locked, false);
  assert.equal(writable.locked, false);
  await transport.close();
  await transport.open();
  await transport.close();
  assert.equal(port.closes, 3);
});

test('a second transport cannot acquire or close the first transport’s port', async () => {
  const port = serialPort();
  const first = new WebSerialTransport(port);
  const second = new WebSerialTransport(port);
  await first.open();
  await assert.rejects(second.open(), /Already open/);
  await second.close();
  assert.equal(port.closes, 0);
  await first.write(new Uint8Array([255]));
  await first.close();
  await second.open();
  await second.close();
});

test('writer setup failure closes the opened port so retry can succeed', async () => {
  const port = serialPort();
  const setSignals = port.setSignals;
  port.setSignals = async () => {
    port.writable.getWriter = () => { throw new TypeError('Writer setup failed'); };
  };
  const transport = new WebSerialTransport(port);
  await assert.rejects(transport.open(), /Writer setup failed/);
  assert.equal(port.opened, false);
  assert.equal(transport.isOpen, false);
  port.setSignals = setSignals;
  await transport.open();
  await transport.close();
});
