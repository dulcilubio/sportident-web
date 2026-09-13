// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dulcilubio
// See NOTICE and LICENSE at the repository root.

/**
 * Offline service worker.
 *
 * Timing happens in forests, car parks and sports halls, where the network is
 * whatever someone's phone can manage. Once this page has been opened, it has
 * to keep opening -- talking to a station over USB needs no internet at all,
 * so losing the internet must not cost you the tool.
 *
 * Everything the page is built from is cached on first visit and served from
 * there afterwards, with the network used to refresh quietly in the
 * background. Requests to other origins, such as the SIAC battery lookup, are
 * never cached: they are the one part that genuinely needs a connection, and a
 * stale answer would be worse than an honest failure.
 */

const VERSION = 'si-tool-v1';

/** Everything needed to start the page with no network at all. */
const SHELL = [
  './',
  './index.html',
  './app.js',
  '../src/battery.js',
  '../src/bytes.js',
  '../src/connect.js',
  '../src/constants.js',
  '../src/control.js',
  '../src/csv.js',
  '../src/errors.js',
  '../src/framer.js',
  '../src/holder.js',
  '../src/index.js',
  '../src/protocol.js',
  '../src/readout.js',
  '../src/simulator.js',
  '../src/station.js',
  '../src/transport.js',
  '../src/webusb.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // Individually, so one missing file cannot leave the page with no cache
      // at all. A page that mostly works offline beats one that does not.
      await Promise.all(
        SHELL.map((url) => cache.add(url).catch(() => console.warn('sw: could not cache', url)))
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Another origin means the battery lookup. Let it succeed or fail honestly.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(request, { ignoreSearch: true });

      // Refresh in the background so a later visit gets the newer file, but
      // never make the page wait for the network to time out.
      const fresh = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      if (hit) return hit;

      const response = await fresh;
      if (response) return response;

      // Nothing cached and nothing reachable.
      return new Response('Offline, and this file was never cached.', {
        status: 504,
        headers: { 'Content-Type': 'text/plain' },
      });
    })()
  );
});
