// Rough workload timings mirroring the kit bench (medians of 3 rounds
// after warm-ups in the real suite; here a single round each).
// Usage: FORGE_PORT=40565 node test/bench.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const PORT = process.env.FORGE_PORT;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'testtoken123';

async function req(method, path, body = undefined) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json };
}

const now = () => performance.now();

// Setup: create the bench repo and a 200-commit history via REST contents.
console.log('setup: creating bench repo with 200 commits...');
await req('POST', '/api/v3/user/repos', { name: 'bench' });
{
  const t0 = now();
  for (let i = 0; i < 200; i += 1) {
    const r = await req('PUT', `/api/v3/repos/adaiversen/bench/contents/f${i}.txt`, {
      message: `commit ${i}`,
      content: Buffer.from(`content ${i}\n`.repeat(20)).toString('base64'),
    });
    if (r.status !== 201 && r.status !== 200) throw new Error(`setup commit ${i} failed: ${r.status}`);
  }
  console.log(`setup 200 commits via REST: ${((now() - t0) / 1000).toFixed(1)}s`);
}

// Workload 1: push 200x 1 KiB pushes (git CLI, one commit each).
{
  const dir = mkdtempSync(join(tmpdir(), 'bench-push-'));
  await exec('git', ['clone', '-q', `${BASE}/adaiversen/bench.git`, dir + '/w']);
  const w = dir + '/w';
  await exec('git', ['-C', w, 'config', 'user.name', 'Bench']);
  await exec('git', ['-C', w, 'config', 'user.email', 'bench@example.invalid']);
  const t0 = now();
  for (let i = 0; i < 200; i += 1) {
    const data = Buffer.alloc(1024, 65 + (i % 26));
    writeFileSync(join(w, `push-${i}.bin`), data);
    await exec('git', ['-C', w, 'add', '.']);
    await exec('git', ['-C', w, 'commit', '-qm', `push ${i}`]);
    await exec('git', ['-C', w, 'push', '-q', `${BASE}/adaiversen/bench.git`, 'main']);
  }
  const dt = now() - t0;
  console.log(`push 200x 1KiB: ${dt.toFixed(0)} ms total (${(dt / 200).toFixed(2)} ms/push) [T_ref 1640.82 ms]`);
  rmSync(dir, { recursive: true, force: true });
}

// Workload 2: clone 50 concurrent shallow depth-1 of the 200-commit repo.
{
  const dir = mkdtempSync(join(tmpdir(), 'bench-clone-'));
  const t0 = now();
  const jobs = [];
  for (let i = 0; i < 50; i += 1) {
    jobs.push(exec('git', ['clone', '-q', '--depth', '1', `${BASE}/adaiversen/bench.git`, `${dir}/c${i}`]));
  }
  await Promise.all(jobs);
  const dt = now() - t0;
  console.log(`clone 50 concurrent shallow depth-1: ${dt.toFixed(0)} ms total [T_ref 266.941 ms]`);
  rmSync(dir, { recursive: true, force: true });
}

// Workload 3: read 2000 GET issues sequential on one keep-alive connection.
{
  // Seed 200 issues first (not timed).
  for (let i = 0; i < 200; i += 1) {
    await req('POST', '/api/v3/repos/adaiversen/bench/issues', { title: `issue ${i}` });
  }
  const t0 = now();
  for (let i = 0; i < 2000; i += 1) {
    const r = await req('GET', `/api/v3/repos/adaiversen/bench/issues?per_page=100`);
    if (r.status !== 200) throw new Error(`read failed: ${r.status}`);
  }
  const dt = now() - t0;
  console.log(`read 2000 GET issues sequential: ${dt.toFixed(0)} ms total (${(dt / 2000).toFixed(3)} ms/req) [T_ref 2759.715 ms]`);
}

// Workload 4: write 200 issue creations.
{
  const t0 = now();
  for (let i = 0; i < 200; i += 1) {
    const r = await req('POST', '/api/v3/repos/adaiversen/bench/issues', { title: `write ${i}` });
    if (r.status !== 201) throw new Error(`write failed: ${r.status}`);
  }
  const dt = now() - t0;
  console.log(`write 200 issue creations: ${dt.toFixed(0)} ms total (${(dt / 200).toFixed(2)} ms/req) [T_ref 348.965 ms]`);
}

console.log('done');
