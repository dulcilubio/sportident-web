import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SIStation } from '../src/station.js';
import { SimulatedTransport } from '../src/simulator.js';
import { BAUD_HIGH, BAUD_LOW } from '../src/constants.js';

for (const answers of [true, false]) {
  test(`connection retries at each speed (${answers ? 'late reply' : 'no reply'})`, async () => {
    const sim = new SimulatedTransport({ latency: 0 });
    const station = new SIStation(sim, { timeout: 10, retries: 0 });
    const write = sim.write.bind(sim);
    const attempts = [];
    const speeds = [];
    station.addEventListener('connecting', (e) => {
      speeds.push({ ...e.detail, attempts: attempts.length });
    });
    sim.write = async (bytes) => {
      attempts.push(sim.baudRate);
      if (answers && attempts.length >= 30) await write(bytes);
    };
    try {
      const connection = station.connect({ handshakeRetries: 14 });
      if (answers) await connection;
      else await assert.rejects(connection, /No SPORTident station answered/);
      assert.deepEqual(attempts.slice(0, 30), [
        ...Array(15).fill(BAUD_HIGH), ...Array(15).fill(BAUD_LOW),
      ]);
      assert.deepEqual(speeds, [
        { baudRate: BAUD_HIGH, attempts: 0 },
        { baudRate: BAUD_LOW, previousBaudRate: BAUD_HIGH, attempts: 15 },
      ]);
      assert.equal(station.retries, 0, 'normal command retry policy is unchanged');
      if (!answers) assert.equal(attempts.length, 30, 'retry budget is bounded');
    } finally {
      await station.disconnect();
    }
  });
}
