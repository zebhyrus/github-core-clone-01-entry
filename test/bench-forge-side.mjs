// Forge-side timings without git CLI spawn overhead.
//  - push: replay a prebuilt receive-pack POST (new branch each time)
//  - read: 2000 GET single-issue requests
// The pack is built by shell: git pack-objects --revs --stdout.
// Usage: PACK_FILE=/tmp/packdbg-XXX/pack.bin TIP=80434fc8f32b84707ea6245812240c2ecdc29ed7 FORGE_PORT=40565 node test/bench-forge-side.mjs
import { readFileSync } from 'node:fs';

const PORT = process.env.FORGE_PORT;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'testtoken123';
const ZERO = '0000000000000000000000000000000000000000';
const TIP = process.env.TIP;
const pack = readFileSync(process.env.PACK_FILE);

function pktLine(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0'), 'ascii'), b]);
}

console.log(`probe pack: ${pack.length} bytes, tip ${TIP}`);

// Replay the receive-pack POST 200 times (new branch each time) via fetch.
{
  const t0 = performance.now();
  for (let i = 0; i < 200; i += 1) {
    const ref = `refs/heads/bench-${i}`;
    const cmd = pktLine(`${ZERO} ${TIP} ${ref}\0 report-status side-band-64k agent=bench\n`);
    const body = Buffer.concat([cmd, Buffer.from('0000', 'ascii'), pack]);
    const res = await fetch(`${BASE}/adaiversen/bench.git/git-receive-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-git-receive-pack-request' },
      body,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.toString('latin1').includes('unpack ok')) throw new Error(`push ${i} failed: ${buf.toString('latin1').slice(0, 120)}`);
  }
  const dt = performance.now() - t0;
  console.log(`push 200x 1KiB (forge-side, fetch replay): ${dt.toFixed(0)} ms total (${(dt / 200).toFixed(2)} ms/push) [T_ref 1640.82 ms]`);
}

// Read: 2000 GET single-issue requests on one keep-alive connection.
{
  const t0 = performance.now();
  for (let i = 0; i < 2000; i += 1) {
    const res = await fetch(`${BASE}/api/v3/repos/adaiversen/bench/issues/${1 + (i % 200)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    if (res.status !== 200) throw new Error(`read failed: ${res.status}`);
    await res.text();
  }
  const dt = performance.now() - t0;
  console.log(`read 2000 GET single issues: ${dt.toFixed(0)} ms total (${(dt / 2000).toFixed(3)} ms/req) [T_ref 2759.715 ms]`);
}
console.log('done');
