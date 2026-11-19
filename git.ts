// git smart HTTP: protocol v2 upload-pack (advertisement, ls-refs, fetch),
// v0 upload-pack, and v0 receive-pack. Full objects only, no deltas on the
// wire out; deltas in incoming packs are resolved on read.

import { deflateSync } from 'node:zlib';
import {
  ZERO_OID, ancestors, applyDelta, commitTree, hashObject, isAncestor, parseCommit,
  parseTag, parseTree, peelToCommit, putObj, readPack, reachableObjects, writePack,
  type GitObj, type Repo,
} from './store.ts';

export function pktLine(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = body.length + 4;
  const head = Buffer.allocUnsafe(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }

// Parse pkt-lines from buf starting at off; returns packets and bytes consumed.
export function parsePkts(buf: Buffer, off = 0): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let i = off;
  while (i + 4 <= buf.length) {
    const head = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 2) { packets.push({ kind: 'end', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, consumed: i - off };
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function defaultTip(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

function peeledOf(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  return peelToCommit(repo, oid);
}

// v0 ref advertisement body (with the # service= preamble).
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const tip = defaultTip(repo);
  const symref = tip === undefined ? '' : ` symref=HEAD:refs/heads/${repo.defaultBranch}`;
  let caps: string;
  if (service === 'git-upload-pack') {
    caps = `side-band-64k multi_ack_detailed thin-pack ofs-delta shallow agent=forge/1.0${symref}`;
  } else {
    caps = `report-status side-band-64k delete-refs ofs-delta agent=forge/1.0${symref}`;
  }
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headLine = tip === undefined ? null : `${tip} HEAD\0${caps}\n`;
    if (headLine !== null) parts.push(pktLine(headLine));
    let first = headLine === null;
    for (const ref of refs) {
      const line = first ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      first = false;
      parts.push(pktLine(line));
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== undefined && ref.name.startsWith('refs/tags/')) {
        parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// v2 capability advertisement body.
export function advertiseV2(): Buffer {
  const parts = [
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine('agent=forge/1.0\n'),
    FLUSH,
  ];
  return Buffer.concat(parts);
}

export interface LsRefsOpts { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }

// v2 ls-refs response.
export function lsRefs(repo: Repo, opts: LsRefsOpts): Buffer {
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const keep = (name: string): boolean =>
    opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  const tip = defaultTip(repo);
  const wantHead = opts.prefixes.length === 0 || opts.prefixes.some((p) => 'HEAD'.startsWith(p));
  if (wantHead) {
    if (tip !== undefined) {
      const attrs = opts.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(pktLine(`${tip} HEAD${attrs}\n`));
    } else if (opts.unborn) {
      const attrs = opts.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(pktLine(`unborn HEAD${attrs}\n`));
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (opts.peel) {
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch planning

export interface FetchPlan {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

// Objects reachable from `roots`, following commit parents only while the
// parent commit is in `through` (or through is null for all parents), and
// always following trees/blobs. A commit in `stopAt` contributes itself and
// its tree but not its parents: that is how a client's shallow boundary
// stops the "already have" exclusion.
function reachableBounded(
  repo: Repo, roots: Iterable<string>, through: Set<string> | null, stopAt: Set<string>,
): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  const seenCommit = new Set<string>();
  const collectTree = (treeOid: string): void => {
    const tstack = [treeOid];
    while (tstack.length > 0) {
      const t = tstack.pop()!;
      if (out.has(t)) continue;
      const tobj = repo.objects.get(t);
      if (!tobj || tobj.type !== 'tree') continue;
      out.add(t);
      for (const e of parseTree(tobj.data)) {
        if (e.oid === '' || out.has(e.oid)) continue;
        const eobj = repo.objects.get(e.oid);
        if (!eobj) continue;
        if (eobj.type === 'tree') tstack.push(e.oid);
        else out.add(e.oid);
      }
    }
  };
  for (const r of roots) stack.push(r);
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      if (seenCommit.has(oid)) continue;
      seenCommit.add(oid);
      const c = parseCommit(obj.data);
      collectTree(c.tree);
      if (!stopAt.has(oid)) {
        for (const p of c.parents) {
          if (through === null || through.has(p)) stack.push(p);
        }
      }
    } else if (obj.type === 'tree') {
      collectTree(oid);
    } else if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (through === null || through.has(target)) stack.push(target);
    }
  }
  return out;
}

// Compute which objects a fetch of `wants` sends, given the client's haves,
// an optional depth, and the client's shallow boundaries.
//
// Depth semantics: `depth` is the TOTAL depth from the wants (what the
// suite's client sends), unless `deepenRelative` is set (what git CLI sends
// when deepening), in which case it extends the client's current shallow
// boundary by that many generations. With no depth at all, a shallow
// boundary still caps the walk at the boundary itself.
export function planFetch(
  repo: Repo, wants: string[], haves: string[], depth: number | undefined,
  shallowReq: string[], deepenRelative = false,
): FetchPlan {
  const shallowSet = new Set(shallowReq);
  // Distance (generations) from the nearest want, following parents.
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (repo.objects.has(target) && !dist.has(target)) {
        dist.set(target, 0);
        queue.push([target, 0]);
      }
    } else if (obj.type === 'commit') {
      if (!dist.has(w)) {
        dist.set(w, 0);
        queue.push([w, 0]);
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const [oid, d] = queue[head]!;
    head += 1;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!dist.has(p) && repo.objects.has(p)) {
        dist.set(p, d + 1);
        queue.push([p, d + 1]);
      }
    }
  }
  // Effective total depth D: include commits with dist < D.
  let D: number | undefined;
  const maxShallowDist = (): number | undefined => {
    let m: number | undefined;
    for (const s of shallowReq) {
      const d = dist.get(s);
      if (d !== undefined && (m === undefined || d > m)) m = d;
    }
    return m;
  };
  if (depth !== undefined) {
    if (deepenRelative) {
      const m = maxShallowDist();
      D = m === undefined ? depth : m + 1 + depth;
    } else {
      D = depth;
    }
  } else {
    const m = maxShallowDist();
    if (m !== undefined) D = m + 1;
  }
  const included = new Set<string>();
  for (const [oid, d] of dist) {
    if (D === undefined || d < D) included.add(oid);
  }
  // Tag wants themselves are always included.
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj && obj.type === 'tag') included.add(w);
  }
  const boundary = new Set<string>();
  for (const oid of included) {
    const d = dist.get(oid);
    if (D !== undefined && d !== undefined && d === D - 1) boundary.add(oid);
    if (shallowSet.has(oid)) boundary.add(oid);
  }
  // Objects to send: everything reachable from the included commits without
  // crossing below an included commit's parents (parents are only sent when
  // they are themselves included), minus what the client already holds.
  // The already-held exclusion stops at the client's shallow boundary: a
  // shallow have contributes itself and its tree, never its parents.
  const send = reachableBounded(repo, included, included, new Set<string>());
  for (const h of haves) {
    for (const o of reachableBounded(repo, [h], null, shallowSet)) send.delete(o);
  }
  const objects: GitObj[] = [];
  for (const oid of [...send].sort()) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  // A former shallow boundary is unshallowed once all of its parents are
  // included; it must not also be listed as shallow.
  const unshallow: string[] = [];
  const unshallowSet = new Set<string>();
  for (const s of shallowReq) {
    if (!included.has(s)) continue;
    const obj = repo.objects.get(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => included.has(p))) {
      unshallow.push(s);
      unshallowSet.add(s);
    }
  }
  unshallow.sort();
  const shallow: string[] = [];
  for (const b of boundary) {
    if (included.has(b) && !unshallowSet.has(b)) shallow.push(b);
  }
  shallow.sort();
  const acks: string[] = [];
  for (const h of haves) {
    if (repo.objects.has(h)) acks.push(h);
  }
  return { objects, shallow, unshallow, acks };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 60000;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.from([1])));
  }
  return Buffer.concat(parts);
}

// v2 fetch response. The acknowledgments section is sent only when the
// client sent haves; a fresh clone gets no acknowledgments section at all
// (the response starts with shallow-info or packfile). Shallow lines carry
// no trailing newline.
export function fetchV2(repo: Repo, wants: string[], haves: string[], depth: number | undefined, shallowReq: string[], deepenRelative = false): Buffer {
  const plan = planFetch(repo, wants, haves, depth, shallowReq, deepenRelative);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(writePack(plan.objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// v0 fetch response. git CLI speaks v0 in two POSTs: round 1 (no `done`)
// of a shallow fetch gets the shallow list + FLUSH and nothing else; the
// pack phase (round 2, or a single POST carrying `done`) gets the shallow
// list + FLUSH, then the NAK/ACK lines, then the sideband pack. A round-1
// POST without a shallow request gets the ack lines + the pack, as before.
// Shallow lines carry no trailing newline.
export function fetchV0(
  repo: Repo, wants: string[], haves: string[], depth: number | undefined,
  shallowReq: string[], deepenRelative = false, hasDone = true,
): Buffer {
  const plan = planFetch(repo, wants, haves, depth, shallowReq, deepenRelative);
  const parts: Buffer[] = [];
  const hasShallow = plan.shallow.length > 0 || plan.unshallow.length > 0;
  if (!hasDone && hasShallow) {
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}`));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  if (hasShallow) {
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}`));
    parts.push(FLUSH);
  }
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(sidebandPack(writePack(plan.objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// Parse a v2 upload-pack request body into a command and its arguments.
export function parseV2Request(body: Buffer): { command: string; args: Map<string, string[]>; raw: string[] } {
  const { packets } = parsePkts(body);
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  let command = '';
  const args = new Map<string, string[]>();
  let afterDelim = false;
  for (const line of lines) {
    if (line.startsWith('command=')) {
      command = line.slice('command='.length);
      continue;
    }
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    const eq = line.indexOf(' ');
    const key = eq === -1 ? line : line.slice(0, eq);
    const val = eq === -1 ? '' : line.slice(eq + 1);
    if (!args.has(key)) args.set(key, []);
    args.get(key)!.push(val);
    void afterDelim;
  }
  return { command, args, raw: lines };
}

// Parse a v0 upload-pack request body: wants, haves, depth, shallow list.
// Also reports whether the request carries a `done` line and whether a
// second flush-separated section carries haves: git CLI speaks v0 in two
// POSTs (round 1 has no `done`, round 2 does), while a single-POST client
// sends wants, then haves + done in a second section of one body.
export function parseV0Request(body: Buffer): { wants: string[]; haves: string[]; depth: number | undefined; shallow: string[]; deepenRelative: boolean; hasDone: boolean; secondSectionHasHaves: boolean } {
  const { packets } = parsePkts(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let deepenRelative = false;
  let hasDone = false;
  let secondSectionHasHaves = false;
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') { section += 1; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'deepen-relative') { deepenRelative = true; continue; }
    if (line === 'done') { hasDone = true; continue; }
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    } else {
      if (line.startsWith('have ')) { haves.push(line.slice(5).trim()); secondSectionHasHaves = true; }
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    }
  }
  return { wants, haves, depth, shallow, deepenRelative, hasDone, secondSectionHasHaves };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand { oldOid: string; newOid: string; ref: string }

// Handle a receive-pack POST. Returns the sideband-framed report-status body.
export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, consumed } = parsePkts(body);
  const commands: PushCommand[] = [];
  let sawFlush = false;
  for (const p of packets) {
    if (p.kind === 'flush') { sawFlush = true; break; }
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  void sawFlush;
  const packBytes = body.subarray(consumed);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  if (hasUpdates || packBytes.length > 0) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack error';
      }
    }
  }
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  for (const cmd of commands) {
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpack failed';
    } else {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (current === undefined) { reason = 'ref does not exist'; }
        else if (current !== cmd.oldOid && cmd.oldOid !== ZERO_OID) { reason = 'non-fast-forward'; }
        else { repo.refs.delete(cmd.ref); ok = true; }
      } else if (!repo.objects.has(cmd.newOid)) {
        reason = 'missing object';
      } else if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) reason = 'already exists';
        else { repo.refs.set(cmd.ref, cmd.newOid); ok = true; }
      } else {
        if (current === undefined) { reason = 'ref does not exist'; }
        else if (current !== cmd.oldOid) { reason = 'non-fast-forward'; }
        else if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) { reason = 'non-fast-forward'; }
        else { repo.refs.set(cmd.ref, cmd.newOid); ok = true; }
      }
    }
    reportLines.push(ok ? `ok ${cmd.ref}` : `ng ${cmd.ref} ${reason}`);
  }
  // Report-status lines are pkt-framed inside band 1 (this is what git's
  // own http-backend sends), the band-1 stream ends with an inner FLUSH,
  // and the response ends with a top-level FLUSH.
  const inner = Buffer.concat([...reportLines.map((l) => pktLine(`${l}\n`)), FLUSH]);
  return Buffer.concat([sidebandPack(inner), FLUSH]);
}

// Handle an upload-pack POST (v2 or v0, chosen by the caller).
export function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): Buffer {
  if (isV2) {
    const { command, args } = parseV2Request(body);
    if (command === 'ls-refs') {
      const opts: LsRefsOpts = {
        peel: (args.get('peel') ?? []).length > 0 || args.has('peel'),
        symrefs: args.has('symrefs'),
        unborn: args.has('unborn'),
        prefixes: args.get('ref-prefix') ?? [],
      };
      // parseV2Request drops bare keys without values; detect them from raw lines instead.
      return lsRefs(repo, opts);
    }
    if (command === 'fetch') {
      const wants = args.get('want') ?? [];
      const haves = args.get('have') ?? [];
      const deepenRaw = args.get('deepen')?.[0];
      const depth = deepenRaw === undefined ? undefined : Number(deepenRaw);
      const shallow = args.get('shallow') ?? [];
      const deepenRelative = args.has('deepen-relative');
      return fetchV2(repo, wants, haves, Number.isFinite(depth) ? depth : undefined, shallow, deepenRelative);
    }
    return Buffer.concat([pktLine('unexpected command\n'), FLUSH]);
  }
  const { wants, haves, depth, shallow, deepenRelative, hasDone } = parseV0Request(body);
  return fetchV0(repo, wants, haves, depth, shallow, deepenRelative, hasDone);
}
