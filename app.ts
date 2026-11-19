// HTTP front end: one server, four surfaces (git smart HTTP, REST v3,
// GraphQL, MCP) over a single in-memory store. No wall clock, no randomness.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { handleUploadPack, handleReceivePack, advertiseV0, advertiseV2 } from './git.ts';
import { handleRest, type RestCtx } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, json: unknown, extra: Record<string, string> = {}): void {
  const body = json === null || json === undefined ? '' : JSON.stringify(json);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(body);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function isAuthorized(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  if (TOKEN !== '') return auth === `Bearer ${TOKEN}`;
  return auth.startsWith('Bearer ') && auth.length > 7;
}

function splitPath(raw: string): { segments: string[]; query: URLSearchParams } {
  const url = new URL(raw, 'http://localhost');
  const segments = url.pathname.split('/').filter((p) => p !== '');
  return { segments, query: url.searchParams };
}

export function createApp(): ReturnType<typeof createServer> {
  const store = new Store();
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(store, req, res);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Internal Server Error';
      if (!res.headersSent) sendJson(res, 500, { message });
      else res.end();
    }
  });
  return server;
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const { segments, query } = splitPath(rawUrl);
  const host = req.headers.host ?? 'localhost';
  const baseUrl = `http://${host}`;

  if (segments.length === 1 && segments[0] === 'healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/info/refs, /{owner}/{repo}.git/git-upload-pack,
  // /{owner}/{repo}.git/git-receive-pack
  if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
    const owner = decodeURIComponent(segments[0]!);
    const repoName = decodeURIComponent(segments[1]!.slice(0, -4));
    const action = segments[2]!;
    const repo = store.findRepo(owner, repoName);
    const body = await readBody(req);
    if (action === 'info' && segments[3] === 'refs' && segments.length === 4 && method === 'GET') {
      if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const service = query.get('service') ?? '';
      // Protocol v2: the client asks with Git-Protocol: version=2 and the
      // reply is the v2 capability advertisement (no # service= preamble).
      if (service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2') {
        sendRaw(res, 200, advertiseV2(), 'application/x-git-upload-pack-advertisement');
        return;
      }
      const out = handleUploadPackAdvertise(repo, service);
      if (out === null) { sendJson(res, 400, { message: 'Bad Request' }); return; }
      sendRaw(res, 200, out.body, out.contentType);
      return;
    }
    if (action === 'git-upload-pack' && segments.length === 3 && method === 'POST') {
      if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const out = handleUploadPack(repo, body, req.headers['git-protocol'] === 'version=2');
      sendRaw(res, 200, out, 'application/x-git-upload-pack-result');
      return;
    }
    if (action === 'git-receive-pack' && segments.length === 3 && method === 'POST') {
      if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const out = handleReceivePack(repo, body);
      sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!isAuthorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
    const restSegments = segments.slice(2);
    const rawBody = await readBody(req);
    let body: unknown = null;
    let bodyInvalid = false;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        bodyInvalid = true;
      }
    }
    const ctx: RestCtx = { method, segments: restSegments, query, body, bodyInvalid, baseUrl };
    const result = handleRest(store, ctx);
    if (result.status === 204) {
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, result.status, result.json, result.headers);
    return;
  }

  // GraphQL
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (!isAuthorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
    const rawBody = await readBody(req);
    let body: unknown = null;
    try {
      body = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) : null;
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Invalid JSON' }] });
      return;
    }
    const result = handleGraphQL(store, body);
    sendJson(res, result.status, result.json);
    return;
  }

  // MCP
  if (segments.length === 1 && segments[0] === 'mcp') {
    if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (!isAuthorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
    const rawBody = await readBody(req);
    let body: unknown = null;
    let parseFailed = false;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        parseFailed = true;
      }
    } else {
      parseFailed = true;
    }
    if (parseFailed) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const result = handleMcp(store, body);
    if (result.status === 202 || result.json === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, result.status, result.json);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function handleUploadPackAdvertise(
  repo: import('./store.ts').Repo,
  service: string,
): { body: Buffer; contentType: string } | null {
  // Advertisement is produced by the git module; this helper only maps the
  // requested service name to the right content type.
  if (service === 'git-upload-pack') {
    return { body: advertiseV0(repo, 'git-upload-pack'), contentType: 'application/x-git-upload-pack-advertisement' };
  }
  if (service === 'git-receive-pack') {
    return { body: advertiseV0(repo, 'git-receive-pack'), contentType: 'application/x-git-receive-pack-advertisement' };
  }
  return null;
}

export { VIEWER_LOGIN };
