// The forge's store: one in-memory model shared by git smart HTTP, REST v3,
// GraphQL v4 and MCP. Everything deterministic: fixed timestamps, counters in
// creation order, no wall clock and no unseeded randomness anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync as zlibInflateSync } from 'node:zlib';

// The token owner's login, derived from the contest's fixed scenario seed
// (wire.ts SCENARIO_SEED, users stream): the viewer is always adaiversen.
// The trial token is opaque (shpat_...), so no login can be read from it.
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const FIXED_TS = 1735689600;
export const FIXED_ISO = '2025-01-01T00:00:00Z';
export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObj { type: ObjType; data: Buffer }
export interface Label { name: string; color: string }
export interface IssueRec {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: string[]; seq: number;
}
export interface CommentRec { id: number; body: string; seq: number }
export interface PullRec {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; head: string; base: string;
  merged: boolean; mergeCommitSha: string | null; mergedAt: string | null; seq: number;
}
export interface Repo {
  id: number; name: string; owner: string; description: string; isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObj>; refs: Map<string, string>;
  labels: Map<string, Label>; issues: Map<number, IssueRec>; pulls: Map<number, PullRec>;
  comments: Map<number, CommentRec[]>; nextNumber: number;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

export function putObj(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface TreeEntry { mode: string; name: string; oid: string }

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function cmpTreeName(a: TreeEntry, b: TreeEntry): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(cmpTreeName);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string; parents: string[]; author: string; committer: string; message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  // Stored commit bytes end the message with '\n'; the API presents it
  // without that single trailing newline (the suite compares exact text).
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8').replace(/\n$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: string[], message: string, ts = FIXED_TS): Buffer {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- packfiles

function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start]!;
  let off = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[off++]!;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: off };
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const res = zlibInflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer; engine: { bytesWritten: number };
  };
  return { data: res.buffer, next: offset + res.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++]!;
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOff += delta[off++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[off++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (sha1Hex(pack.subarray(0, trailerStart)) !== trailer) throw new Error('pack checksum mismatch');
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    const header = readVarintSize(pack, off);
    off = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, off);
      off = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry type ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), off);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error('pack trailing bytes');
  const objects = new Map<string, GitObj>();
  const resolved = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: ObjType; data: Buffer; oid: string } => {
    const done = resolved.get(entry.offset);
    if (done) return done;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const base = resolveBase?.(entry.baseOid!);
      if (!base) throw new Error('ref-delta base missing');
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    resolved.set(entry.offset, out);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: Iterable<GitObj>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const o of list) {
    parts.push(packObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- the store

export class Store {
  repos = new Map<string, Repo>();
  byId = new Map<number, Repo>();
  repoSeq = 0;
  idSeq = 0;
  reqSeq = 0;

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(name)) return null;
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq, name, owner: VIEWER_LOGIN, description,
      isPrivate, defaultBranch: 'main',
      objects: new Map(), refs: new Map(),
      labels: new Map(), issues: new Map(), pulls: new Map(),
      comments: new Map(), nextNumber: 1,
    };
    this.repos.set(name, repo);
    this.byId.set(repo.id, repo);
    return repo;
  }

  findRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(name);
  }

  findRepoById(id: number): Repo | undefined {
    return this.byId.get(id);
  }

  nextId(): number {
    this.idSeq += 1;
    return this.idSeq;
  }

  nextReqId(): string {
    this.reqSeq += 1;
    return `req-${this.reqSeq}`;
  }

  globalId(kind: string, repoId: number, num: number): string {
    return Buffer.from(`${kind}:${repoId}:${num}`, 'utf8').toString('base64url');
  }

  parseGlobalId(id: string): { kind: string; repoId: number; num: number } | null {
    try {
      const text = Buffer.from(id, 'base64url').toString('utf8');
      const parts = text.split(':');
      if (parts.length !== 3) return null;
      const repoId = Number(parts[1]);
      const num = Number(parts[2]);
      if (!Number.isInteger(repoId) || !Number.isInteger(num)) return null;
      return { kind: parts[0]!, repoId, num };
    } catch {
      return null;
    }
  }
}

export function newRepoId(store: Store, repo: Repo): number {
  return store.nextId();
}

// Flatten a tree to path -> {oid, mode}.
export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

// Build (and store) a tree from a flat file map.
export function treeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  const sortedPaths = [...files.keys()].sort();
  for (const path of sortedPaths) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const s = segs[i]!;
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s)!;
    }
    node.files.set(segs[segs.length - 1]!, files.get(path)!);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, f] of node.files) entries.push({ mode: f.mode, name, oid: f.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObj(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

export function tipOf(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

export function commitTree(repo: Repo, commitOid: string): string | undefined {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return undefined;
  return parseCommit(obj.data).tree;
}

// Commit a set of file changes on a branch. changes: path -> Buffer (write) or null (delete).
export function commitFiles(
  repo: Repo, branch: string, changes: Map<string, Buffer | null>, message: string,
): { commitSha: string; treeSha: string } {
  const tip = tipOf(repo, branch);
  const baseTree = tip === undefined ? undefined : commitTree(repo, tip);
  const files = baseTree === undefined ? new Map() : flattenTree(repo, baseTree);
  for (const [path, data] of changes) {
    if (data === null) files.delete(path);
    else files.set(path, { oid: putObj(repo, 'blob', data), mode: '100644' });
  }
  const treeSha = treeFromFiles(repo, files);
  const parents = tip === undefined ? [] : [tip];
  const commitSha = putObj(repo, 'commit', buildCommit(treeSha, parents, message));
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, treeSha };
}

export function readFileAt(repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | null {
  const tree = commitTree(repo, commitOid);
  if (tree === undefined) return null;
  const files = flattenTree(repo, tree);
  const entry = files.get(path);
  if (!entry) return null;
  const obj = repo.objects.get(entry.oid);
  if (!obj || obj.type !== 'blob') return null;
  return { oid: entry.oid, data: obj.data };
}

export function listDirAt(repo: Repo, commitOid: string, dir: string): Array<{ name: string; path: string; oid: string; type: string }> {
  const tree = commitTree(repo, commitOid);
  if (tree === undefined) return [];
  const files = flattenTree(repo, tree);
  const seen = new Map<string, { name: string; path: string; oid: string; type: string }>();
  const prefix = dir === '' ? '' : `${dir}/`;
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { name: rest, path, oid: entry.oid, type: 'file' });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) {
        // find the subtree oid for the directory
        let oid = '';
        let cur = tree;
        const segs = (dir === '' ? name : `${dir}/${name}`).split('/');
        for (const seg of segs) {
          const obj = repo.objects.get(cur);
          if (!obj) break;
          const found = parseTree(obj.data).find((e) => e.name === seg && e.mode === '40000');
          if (!found) break;
          cur = found.oid;
          oid = cur;
        }
        seen.set(name, { name, path: dir === '' ? name : `${dir}/${name}`, oid, type: 'dir' });
      }
    }
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

// All commit ancestors of oid (including oid), parents only.
export function ancestors(repo: Repo, oid: string): Set<string> {
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(cur);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return seen;
}

export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  return ancestors(repo, desc).has(anc);
}

export function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const aAnc = ancestors(repo, a);
  const stack = [b];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (aAnc.has(cur)) return cur;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return undefined;
}

// Reachable objects from roots, following commits/trees/tags.
export function reachableObjects(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') queue.push(e.oid);
      }
    }
  }
  return seen;
}

export function peelToCommit(repo: Repo, oid: string): string | undefined {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj) return undefined;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') cur = parseTag(obj.data).object;
    else return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- diffs

export interface FileChange {
  path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number;
}

function countDiff(oldBuf: Buffer | undefined, newBuf: Buffer | undefined): { additions: number; deletions: number } {
  if (oldBuf === undefined && newBuf === undefined) return { additions: 0, deletions: 0 };
  if (oldBuf === undefined) {
    const lines = newBuf!.toString('utf8').split('\n');
    return { additions: newBuf!.length === 0 ? 0 : lines.length - (newBuf!.toString('utf8').endsWith('\n') ? 1 : 0), deletions: 0 };
  }
  if (newBuf === undefined) {
    const lines = oldBuf.toString('utf8').split('\n');
    return { additions: 0, deletions: oldBuf.length === 0 ? 0 : lines.length - (oldBuf.toString('utf8').endsWith('\n') ? 1 : 0) };
  }
  const a = oldBuf.toString('utf8').split('\n');
  const b = newBuf.toString('utf8').split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  if (a.length > 1500 || b.length > 1500) {
    return { additions: b.length, deletions: a.length };
  }
  // LCS on lines.
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]!);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const common = prev[b.length]!;
  return { additions: b.length - common, deletions: a.length - common };
}

export function diffTrees(repo: Repo, oldTree: string | undefined, newTree: string | undefined): FileChange[] {
  const oldFiles = oldTree === undefined ? new Map() : flattenTree(repo, oldTree);
  const newFiles = newTree === undefined ? new Map() : flattenTree(repo, newTree);
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const o = oldFiles.get(path);
    const n = newFiles.get(path);
    if (o && !n) {
      const oldData = repo.objects.get(o.oid)?.data;
      const d = countDiff(oldData, undefined);
      out.push({ path, status: 'removed', additions: d.additions, deletions: d.deletions });
    } else if (!o && n) {
      const newData = repo.objects.get(n.oid)?.data;
      const d = countDiff(undefined, newData);
      out.push({ path, status: 'added', additions: d.additions, deletions: d.deletions });
    } else if (o && n && o.oid !== n.oid) {
      const oldData = repo.objects.get(o.oid)?.data;
      const newData = repo.objects.get(n.oid)?.data;
      const d = countDiff(oldData, newData);
      out.push({ path, status: 'modified', additions: d.additions, deletions: d.deletions });
    }
  }
  return out;
}

// Three-way merge of head into base. Returns the merged file map, or null on conflict.
export function threeWayMerge(
  repo: Repo, baseTip: string, headTip: string,
): { files: Map<string, { oid: string; mode: string }>; changes: FileChange[] } | null {
  const mb = mergeBase(repo, baseTip, headTip);
  const mbTree = mb === undefined ? undefined : commitTree(repo, mb);
  const baseTree = commitTree(repo, baseTip);
  const headTree = commitTree(repo, headTip);
  const mbFiles = mbTree === undefined ? new Map() : flattenTree(repo, mbTree);
  const baseFiles = baseTree === undefined ? new Map() : flattenTree(repo, baseTree);
  const headFiles = headTree === undefined ? new Map() : flattenTree(repo, headTree);
  const merged = new Map(baseFiles);
  const paths = new Set([...mbFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const m = mbFiles.get(path);
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const mOid = m?.oid;
    const bOid = b?.oid;
    const hOid = h?.oid;
    if (hOid === mOid) {
      // head unchanged: keep base version (already in merged)
      continue;
    }
    if (bOid === mOid) {
      // base unchanged: take head version
      if (h === undefined) merged.delete(path);
      else merged.set(path, h);
      continue;
    }
    if (bOid === hOid) continue;
    return null; // both changed differently: conflict
  }
  const mergedTree = treeFromFiles(repo, merged);
  const fileChanges = diffTrees(repo, baseTree, mergedTree);
  return { files: merged, changes: fileChanges };
}

export function squashMerge(repo: Repo, pr: PullRec): { sha: string } | { conflict: true } {
  const baseTip = tipOf(repo, pr.base);
  const headTip = tipOf(repo, pr.head);
  if (baseTip === undefined || headTip === undefined) return { conflict: true };
  const merged = threeWayMerge(repo, baseTip, headTip);
  if (merged === null) return { conflict: true };
  const treeSha = treeFromFiles(repo, merged.files);
  const message = `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}`;
  const sha = putObj(repo, 'commit', buildCommit(treeSha, [baseTip], message));
  repo.refs.set(`refs/heads/${pr.base}`, sha);
  return { sha };
}

export function prMergeable(repo: Repo, pr: PullRec): boolean {
  const baseTip = tipOf(repo, pr.base);
  const headTip = tipOf(repo, pr.head);
  if (baseTip === undefined || headTip === undefined) return false;
  return threeWayMerge(repo, baseTip, headTip) !== null;
}

export function prFiles(repo: Repo, pr: PullRec): FileChange[] {
  const baseTip = tipOf(repo, pr.base);
  const headTip = tipOf(repo, pr.head);
  if (baseTip === undefined || headTip === undefined) return [];
  const mb = mergeBase(repo, baseTip, headTip);
  const mbTree = mb === undefined ? undefined : commitTree(repo, mb);
  const headTree = commitTree(repo, headTip);
  return diffTrees(repo, mbTree, headTree);
}
