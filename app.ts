// app.ts — the forge's HTTP server: one in-memory store, four surfaces (REST v3, GraphQL,
// MCP, git-over-HTTP), and the lifecycle main.ts drives. Every reply carries
// X-GitHub-Request-Id; every handler is guarded so one bad request never kills the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { handleGitHttp } from './git-http.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { expectedToken, Store } from './store.ts';
import { handleRest } from './rest.ts';

function requestId(): string {
  return randomBytes(8).toString('hex');
}

function jsonResponse(res: ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId(),
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : match[1]!;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunks.reduce((sum, part) => sum + part.length, 0) > 64 * 1024 * 1024) {
        req.destroy(new Error('request body too large'));
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
  const token = bearerToken(req);
  const authed = token !== null && token === expectedToken();

  try {
    // Health probe: public, no auth.
    if (method === 'GET' && pathname === '/healthz') {
      jsonResponse(res, 200, { ok: true });
      return;
    }

    // Git-over-HTTP: the suite's git client never sends a token here, and the spec does not
    // enforce auth on these endpoints.
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
    if (gitMatch !== null) {
      const body = await readBody(req);
      const outcome = await handleGitHttp(store, method, pathname, url.searchParams, req.headers, body);
      res.writeHead(outcome.status, {
        'content-type': outcome.contentType,
        'x-github-request-id': requestId(),
        'content-length': outcome.body.length,
      });
      res.end(outcome.body);
      return;
    }

    // Everything below needs a bearer token, except the two public REST reads.
    const publicRest = method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/' || pathname === '/api/v3/meta');
    if (!publicRest && !authed) {
      jsonResponse(res, 401, { message: 'Requires authentication' });
      return;
    }

    if (pathname === '/api/graphql' || pathname === '/api/v3/graphql') {
      if (method !== 'POST') {
        jsonResponse(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        jsonResponse(res, 400, { errors: [{ message: 'Body is not valid JSON' }] });
        return;
      }
      const reply = handleGraphQL(store, baseUrl, parsed);
      jsonResponse(res, reply.status, reply.body);
      return;
    }

    if (pathname === '/mcp') {
      if (method !== 'POST') {
        jsonResponse(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        jsonResponse(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      const reply = handleMcp(store, baseUrl, parsed);
      if (reply.body === null) {
        res.writeHead(reply.status, { 'x-github-request-id': requestId(), 'content-length': 0 });
        res.end();
        return;
      }
      jsonResponse(res, reply.status, reply.body);
      return;
    }

    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      const raw = await readBody(req);
      let body: unknown;
      let bodyValid = true;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          bodyValid = false;
        }
      }
      const segments = pathname
        .replace(/^\/api\/v3\/?/, '')
        .split('/')
        .filter((part) => part !== '')
        .map((part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            return part;
          }
        });
      const reply = handleRest({
        store,
        method,
        segments,
        query: url.searchParams,
        body,
        bodyValid,
        authed,
        baseUrl,
      });
      const headers: Record<string, string> = { 'x-github-request-id': requestId(), ...(reply.headers ?? {}) };
      const text = JSON.stringify(reply.body);
      res.writeHead(reply.status, { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
      return;
    }

    jsonResponse(res, 404, { message: 'Not Found' });
  } catch (err) {
    // A handler threw: answer 500 and keep the server alive (repo-survives-errors).
    process.stderr.write(`[forge] request ${method} ${pathname} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    if (!res.headersSent) jsonResponse(res, 500, { message: 'Internal Server Error' });
    else res.end();
  }
}

/** Build the server main.ts binds on an ephemeral port and registers with the env. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req, res) => {
    void handleRequest(store, req, res);
  });
}
