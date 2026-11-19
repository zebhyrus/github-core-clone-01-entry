// Entry point for the github-core-clone-01 forge.
//
// Lifecycle (make.fun harness agent/v1):
//   1. Bind an ephemeral port (port 0; never a fixed port).
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register.
//   3. Long-poll GET $MAKEFUN_ENV_URL/done until {"done": true}.
//   4. Close the server and exit 0.
//
// The forge itself is stdlib-only Node: no git binary, no network access
// beyond the harness register/done calls, no outside services. All state
// lives in memory and is deterministic: fixed timestamps, a logical id
// counter, and sorted output everywhere.

import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const DONE_POLL_MS = 500;
const REGISTER_RETRIES = 12;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, payload: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function register(port: number): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < REGISTER_RETRIES; attempt += 1) {
    try {
      const res = await postJson(`${ENV_URL}/register`, { port });
      if (res.ok) return;
      lastError = new Error(`register returned HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    await sleep(250 * (attempt + 1));
  }
  throw lastError instanceof Error ? lastError : new Error('register failed');
}

async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`);
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Transient env hiccup: keep polling.
    }
    await sleep(DONE_POLL_MS);
  }
}

async function main(): Promise<void> {
  if (ENV_URL === '') {
    console.error('MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }
  const app = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, '127.0.0.1', () => {
      const address = app.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine bound port'));
        return;
      }
      resolve(address.port);
    });
  });
  await register(port);
  await waitForDone();
  await new Promise<void>((resolve) => {
    app.close(() => resolve());
  });
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
