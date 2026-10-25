import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const worker = await readFile(new URL('../config/sw.js', import.meta.url), 'utf8');

test('online reloads use fresh code and offline reloads use the saved copy', async () => {
  const handlers = {};
  let saved = new Response('old code');
  let offline = false;
  const cache = {
    async match() { return saved.clone(); },
    async put(request, response) { saved = response; },
  };
  runInNewContext(worker, {
    URL, Response,
    self: {
      location: { origin: 'https://si.example' },
      addEventListener: (name, handler) => { handlers[name] = handler; },
    },
    caches: { open: async () => cache },
    fetch: async (request, options) => {
      assert.equal(options.cache, 'no-cache');
      if (offline) throw new TypeError('Offline');
      return new Response('new code');
    },
  });
  async function load() {
    let response;
    handlers.fetch({
      request: new Request('https://si.example/config/app.js?v=7'),
      respondWith: (promise) => { response = promise; },
    });
    return (await response).text();
  }
  assert.equal(await load(), 'new code');
  offline = true;
  assert.equal(await load(), 'new code');
});
