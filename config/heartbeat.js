// SPDX-License-Identifier: GPL-3.0-or-later
import { CMD } from '../src/constants.js';

/** Checks the current target only. UI operations and card transfers take priority. */
export function monitorStation(station, { isIdle, onStatus, onBusyChange = () => {}, interval = 60000 }) {
  let stopped = false;
  let checking = false;
  let lastResponse = null;
  let healthy = null;
  function response() {
    if (stopped) return;
    lastResponse = new Date();
    healthy = true;
    onStatus({ healthy, lastResponse });
  }
  station.addEventListener('frame', response);
  async function check() {
    if (stopped || checking || !station.isOpen || station.isCommunicating || station.busy || !isIdle()) return;
    checking = true;
    onBusyChange();
    try {
      // No wake byte: monitoring must not actively wake a sleeping station.
      await station.sendCommand(CMD.GET_TIME, [], { retries: 0, timeout: 2000, wakeup: false });
      response();
    } catch {
      if (!stopped) {
        healthy = false;
        onStatus({ healthy, lastResponse });
      }
    } finally {
      checking = false;
      onBusyChange();
    }
  }
  const timer = setInterval(check, interval);
  function stop() {
    stopped = true;
    clearInterval(timer);
    station.removeEventListener('frame', response);
    station.removeEventListener('close', closed);
  }
  function closed() {
    stop();
    onStatus({ healthy: false, lastResponse });
  }
  station.addEventListener('close', closed);
  return { check, stop, get checking() { return checking; } };
}
