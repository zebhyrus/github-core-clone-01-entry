// Tiny mock harness env: POST /register, GET /done.
// Usage: node mock-env.mjs [doneAfterMs]  (default: stay not-done)
import { createServer } from 'node:http';

const doneAfterMs = Number(process.argv[2] ?? '600000');
const started = Date.now();
let port = 0;

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/register') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      port = parsed.port;
      console.log(`registered forge port ${port}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/done') {
    const done = Date.now() - started > doneAfterMs;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ done }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(0, '127.0.0.1', () => {
  console.log(`mock env on ${server.address().port}`);
});
