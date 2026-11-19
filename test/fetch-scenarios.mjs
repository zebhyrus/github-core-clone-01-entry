// Suite-style fetch scenarios exercised directly against planFetch.
// Mirrors checks-git.ts: depth-1 clone, deepen 2 (total depth), shallow
// fetch of a new tip, incremental fetch, fetch-nothing-new.
import { Store, putObj, buildCommit, buildTree } from '../store.ts';
import { planFetch } from '../git.ts';

const store = new Store();
const repo = store.createRepo('t', false, '');

function commitWithFile(name, content, parents) {
  const blob = putObj(repo, 'blob', Buffer.from(content));
  const tree = buildTree([{ mode: '100644', name, oid: blob }]);
  const treeOid = putObj(repo, 'tree', tree);
  const data = buildCommit(treeOid, parents, `commit ${name}\n`);
  return putObj(repo, 'commit', data);
}

// Linear history: c1 -> c2 -> c3 (c3 is the tip).
const c1 = commitWithFile('a.txt', 'one\n', []);
const c2 = commitWithFile('b.txt', 'two\n', [c1]);
const c3 = commitWithFile('c.txt', 'three\n', [c2]);
repo.refs.set('refs/heads/main', c3);

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name} ${extra}`); }
}
// planFetch returns GitObj values without oids; identify commits by hashing.
import { hashObject } from '../store.ts';
function commitOids(plan) {
  const out = new Set();
  for (const o of plan.objects) {
    if (o.type === 'commit') out.add(hashObject('commit', o.data));
  }
  return out;
}

// 1. depth-1 clone: only the tip, shallow names the tip.
{
  const plan = planFetch(repo, [c3], [], 1, []);
  const commits = commitOids(plan);
  check('depth-1 clone has tip only', commits.has(c3) && !commits.has(c2) && !commits.has(c1), [...commits].join(','));
  check('depth-1 shallow names tip', plan.shallow.includes(c3), plan.shallow.join(','));
  check('depth-1 tip tree+blob present', plan.objects.some((o) => o.type === 'blob'), '');
}

// 2. deepen 2 (TOTAL depth) from shallow [c3], haves [c3]: delivers c2, not c1.
{
  const plan = planFetch(repo, [c3], [c3], 2, [c3]);
  const commits = commitOids(plan);
  check('deepen 2 delivers parent', commits.has(c2), [...commits].join(','));
  check('deepen 2 omits grandparent', !commits.has(c1), [...commits].join(','));
  check('deepen 2 boundary moved', plan.shallow.includes(c2) || plan.unshallow.includes(c3), `shallow=${plan.shallow} unshallow=${plan.unshallow}`);
  check('deepen 2 parent tree present', plan.objects.some((o) => o.type === 'tree'), '');
}

// 3. shallow fetch of a new tip: depth 1, haves [c2], shallow [c2] -> c3 only.
{
  const plan = planFetch(repo, [c3], [c2], 1, [c2]);
  const commits = commitOids(plan);
  check('shallow new tip delivers tip only', commits.has(c3) && !commits.has(c2) && !commits.has(c1), [...commits].join(','));
}

// 4. incremental fetch: wants [c3], haves [c2] -> c3 only (no c2/c1 objects).
{
  const plan = planFetch(repo, [c3], [c2], undefined, []);
  const commits = commitOids(plan);
  check('incremental fetch delivers tip only', commits.has(c3) && !commits.has(c2) && !commits.has(c1), [...commits].join(','));
}

// 5. fetch-nothing-new: wants [c3], haves [c3] -> zero objects.
{
  const plan = planFetch(repo, [c3], [c3], undefined, []);
  check('fetch-nothing-new empty pack', plan.objects.length === 0, `got ${plan.objects.length}`);
}

// 6. deepen-relative (git CLI style): deepen 1 past shallow [c3] -> c2.
{
  const plan = planFetch(repo, [c3], [c3], 1, [c3], true);
  const commits = commitOids(plan);
  check('deepen-relative 1 delivers parent', commits.has(c2) && !commits.has(c1), [...commits].join(','));
}

// 7. full clone: all commits.
{
  const plan = planFetch(repo, [c3], [], undefined, []);
  const commits = commitOids(plan);
  check('full clone has all commits', commits.has(c1) && commits.has(c2) && commits.has(c3), [...commits].join(','));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
