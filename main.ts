// main.ts — entrypoint: start the forge, tell the trial environment which
// port it listens on, and keep serving until the environment says the trial
// is finished.
//
// When MAKEFUN_ENV_URL is set (a trial), the process announces its ephemeral
// port to that environment and exits once the environment reports completion.
// When it is unset (a local run, or the kit's conformance runner), the
// process just listens on a random local port, prints the address, and serves
// until it is stopped.

import { createApp } from './app.ts';
import type { Server } from 'node:http';

const ANNOUNCE_RETRY_MS = 500;
const COMPLETION_POLL_MS = 1000;
const SHUTDOWN_GRACE_MS = 2000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function trimSlashes(value: string): string {
  let cut = value.length;
  while (cut > 0 && value[cut - 1] === '/') cut -= 1;
  return value.slice(0, cut);
}

function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const bound = server.address();
      if (bound !== null && typeof bound === 'object') {
        resolve(bound.port);
      } else {
        reject(new Error('server did not bind to a port'));
      }
    });
  });
}

async function announcePort(envRoot: string, port: number): Promise<void> {
  for (;;) {
    try {
      const reply = await fetch(`${envRoot}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (reply.ok) {
        process.stdout.write(`[forge] registered port ${port} with environment\n`);
        return;
      }
      process.stderr.write(`[forge] register answered ${reply.status}, trying again\n`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[forge] register failed (${detail}), trying again\n`);
    }
    await delay(ANNOUNCE_RETRY_MS);
  }
}

async function awaitCompletion(envRoot: string): Promise<void> {
  for (;;) {
    try {
      const reply = await fetch(`${envRoot}/done`);
      if (reply.ok) {
        const payload: unknown = await reply.json();
        if (
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { done?: unknown }).done === true
        ) {
          return;
        }
      }
    } catch {
      // The environment may not be answering yet; ask again shortly.
    }
    await delay(COMPLETION_POLL_MS);
  }
}

async function boot(): Promise<void> {
  const rawRoot = process.env.MAKEFUN_ENV_URL ?? '';
  const envRoot = rawRoot === '' ? '' : trimSlashes(rawRoot);
  const server = createApp();
  const port = await listenEphemeral(server);
  process.stdout.write(`[forge] listening on http://127.0.0.1:${port}\n`);
  if (envRoot === '') {
    process.stdout.write('[forge] no environment URL configured, serving until stopped\n');
    return;
  }
  await announcePort(envRoot, port);
  await awaitCompletion(envRoot);
  process.stdout.write('[forge] environment reports the trial is done, shutting down\n');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
}

boot().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[forge] fatal: ${detail}\n`);
  process.exit(1);
});
