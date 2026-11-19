// REST + GraphQL + MCP smoke tests against a running forge.
// Usage: FORGE_PORT=32783 node test/api-test.mjs
const PORT = process.env.FORGE_PORT;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'testtoken123';
let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; failures.push(name); console.log(`FAIL ${name} ${extra}`); }
}

async function req(method, path, body = undefined, token = TOKEN, rawBody = undefined) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, headers: res.headers, text, json };
}

// ---- REST ----
const noAuth = await req('GET', '/api/v3', undefined, null);
check('REST no auth 401', noAuth.status === 401, `got ${noAuth.status}`);

const root = await req('GET', '/api/v3');
check('REST root 200 + scopes', root.status === 200 && (root.headers.get('x-oauth-scopes') ?? '') !== '', `got ${root.status}`);
check('REST root request id', (root.headers.get('x-github-request-id') ?? '') !== '');

const meta = await req('GET', '/api/v3/meta');
check('REST meta installed_version', meta.status === 200 && typeof meta.json?.installed_version === 'string' && meta.json.installed_version !== '', JSON.stringify(meta.json));

const user = await req('GET', '/api/v3/user');
check('REST user login adaiversen', user.status === 200 && user.json?.login === 'adaiversen', JSON.stringify(user.json));

const create = await req('POST', '/api/v3/user/repos', { name: 'demo', description: 'demo repo' });
check('REST create repo 201', create.status === 201 && create.json?.name === 'demo', `${create.status} ${create.text}`);
const dup = await req('POST', '/api/v3/user/repos', { name: 'demo' });
check('REST dup repo 422 already exists', dup.status === 422 && /already exists/i.test(dup.text), `${dup.status} ${dup.text}`);

const getRepo = await req('GET', '/api/v3/repos/adaiversen/demo');
check('REST get repo 200', getRepo.status === 200 && getRepo.json?.full_name === 'adaiversen/demo', `${getRepo.status}`);
const getOther = await req('GET', '/api/v3/repos/someoneelse/demo');
check('REST other owner 404 not 403', getOther.status === 404, `${getOther.status}`);
const getMissing = await req('GET', '/api/v3/repos/adaiversen/nope');
check('REST missing repo 404', getMissing.status === 404 && typeof getMissing.json?.message === 'string', `${getMissing.status}`);

const patch = await req('PATCH', '/api/v3/repos/adaiversen/demo', { description: 'updated desc' });
check('REST patch description', patch.status === 200 && patch.json?.description === 'updated desc', `${patch.status} ${patch.text}`);

const badJson = await req('POST', '/api/v3/user/repos', undefined, TOKEN, '{not json');
check('REST malformed JSON 400', badJson.status === 400, `${badJson.status}`);
const unknown = await req('GET', '/api/v3/what/is/this');
check('REST unknown route 404 JSON', unknown.status === 404 && typeof unknown.json?.message === 'string', `${unknown.status}`);

// contents
const content = Buffer.from('hello world\n').toString('base64');
const put1 = await req('PUT', '/api/v3/repos/adaiversen/demo/contents/README.md', { message: 'add readme', content });
check('REST contents PUT 201', put1.status === 201 && put1.json?.content?.sha, `${put1.status} ${put1.text}`);
const blobSha = put1.json?.content?.sha;
const getFile = await req('GET', '/api/v3/repos/adaiversen/demo/contents/README.md');
check('REST contents GET file', getFile.status === 200 && getFile.json?.content === content && getFile.json?.sha === blobSha, `${getFile.status} ${getFile.text}`);
const putStale = await req('PUT', '/api/v3/repos/adaiversen/demo/contents/README.md', { message: 'stale', content, sha: '0000000000000000000000000000000000000000' });
check('REST contents stale sha 409', putStale.status === 409, `${putStale.status}`);
const content2 = Buffer.from('hello world v2\n').toString('base64');
const put2 = await req('PUT', '/api/v3/repos/adaiversen/demo/contents/README.md', { message: 'update', content: content2, sha: blobSha });
check('REST contents PUT update 200', put2.status === 200, `${put2.status} ${put2.text}`);
const getDir = await req('GET', '/api/v3/repos/adaiversen/demo/contents/');
check('REST contents GET dir array', getDir.status === 200 && Array.isArray(getDir.json) && getDir.json.some((e) => e.name === 'README.md'), `${getDir.status} ${getDir.text}`);
const delFile = await req('DELETE', '/api/v3/repos/adaiversen/demo/contents/README.md', { message: 'rm', sha: put2.json?.content?.sha });
check('REST contents DELETE 200', delFile.status === 200 && delFile.json?.commit?.sha, `${delFile.status} ${delFile.text}`);
const getGone = await req('GET', '/api/v3/repos/adaiversen/demo/contents/README.md');
check('REST contents GET after delete 404', getGone.status === 404, `${getGone.status}`);

// commits + branches + refs
const commits = await req('GET', '/api/v3/repos/adaiversen/demo/commits');
check('REST commits list', commits.status === 200 && Array.isArray(commits.json) && commits.json.length >= 3, `${commits.status} len=${commits.json?.length}`);
const branches = await req('GET', '/api/v3/repos/adaiversen/demo/branches');
check('REST branches include main', branches.status === 200 && branches.json?.some((b) => b.name === 'main'), `${branches.status} ${branches.text}`);
const refCreate = await req('POST', '/api/v3/repos/adaiversen/demo/git/refs', { ref: 'refs/heads/feature', sha: commits.json?.[0]?.sha });
check('REST git/refs POST 201', refCreate.status === 201, `${refCreate.status} ${refCreate.text}`);

// labels + issues
const label = await req('POST', '/api/v3/repos/adaiversen/demo/labels', { name: 'bug', color: 'ff0000' });
check('REST label 201', label.status === 201 && label.json?.name === 'bug', `${label.status} ${label.text}`);
const badIssue = await req('POST', '/api/v3/repos/adaiversen/demo/issues', { title: 'bad', labels: ['nope'] });
check('REST issue unknown label 422', badIssue.status === 422, `${badIssue.status}`);
const issue1 = await req('POST', '/api/v3/repos/adaiversen/demo/issues', { title: 'first issue', body: 'body here', labels: ['bug'] });
check('REST issue 201', issue1.status === 201 && issue1.json?.number === 1 && issue1.json?.state === 'open', `${issue1.status} ${issue1.text}`);
const issue2 = await req('POST', '/api/v3/repos/adaiversen/demo/issues', { title: 'second issue' });
check('REST issue 2 number 2', issue2.status === 201 && issue2.json?.number === 2, `${issue2.status}`);
const listIssues = await req('GET', '/api/v3/repos/adaiversen/demo/issues');
check('REST list issues', listIssues.status === 200 && listIssues.json?.length === 2, `${listIssues.status} ${listIssues.text}`);
const patchIssue = await req('PATCH', '/api/v3/repos/adaiversen/demo/issues/1', { state: 'closed' });
check('REST close issue', patchIssue.status === 200 && patchIssue.json?.state === 'closed', `${patchIssue.status}`);
const comment = await req('POST', '/api/v3/repos/adaiversen/demo/issues/1/comments', { body: 'a comment' });
check('REST issue comment 201', comment.status === 201 && comment.json?.body === 'a comment', `${comment.status} ${comment.text}`);

// pagination: create 30 repos, list with per_page=10
for (let i = 0; i < 30; i += 1) {
  await req('POST', '/api/v3/user/repos', { name: `page-${i}` });
}
const page1 = await req('GET', '/api/v3/user/repos?per_page=10');
const link1 = page1.headers.get('link') ?? '';
check('REST pagination page1 + Link next', page1.status === 200 && page1.json?.length === 10 && /rel="next"/.test(link1), `${page1.status} len=${page1.json?.length} link=${link1}`);
const nextUrl = /<([^>]+)>;\s*rel="next"/.exec(link1)?.[1];
const page2 = nextUrl ? await req('GET', nextUrl.replace(BASE, '')) : null;
check('REST pagination page2', page2?.status === 200 && page2.json?.length === 10, `${page2?.status} len=${page2?.json?.length}`);

// ---- pulls: need a branch with a commit via contents ----
const putFeat = await req('PUT', '/api/v3/repos/adaiversen/demo/contents/feat.txt', { message: 'feat', content: Buffer.from('feat\n').toString('base64'), branch: 'feature' });
check('REST contents PUT on feature branch', putFeat.status === 201, `${putFeat.status} ${putFeat.text}`);
const pr = await req('POST', '/api/v3/repos/adaiversen/demo/pulls', { title: 'add feat', head: 'feature', base: 'main' });
check('REST create PR 201', pr.status === 201 && pr.json?.number === 3 && pr.json?.head?.ref === 'feature', `${pr.status} ${pr.text}`);
const prNum = pr.json?.number;
const dupPr = await req('POST', '/api/v3/repos/adaiversen/demo/pulls', { title: 'dup', head: 'feature', base: 'main' });
check('REST dup open PR 422', dupPr.status === 422, `${dupPr.status}`);
const prFiles = await req('GET', `/api/v3/repos/adaiversen/demo/pulls/${prNum}/files`);
check('REST PR files', prFiles.status === 200 && prFiles.json?.some((f) => f.filename === 'feat.txt' && f.additions >= 1), `${prFiles.status} ${prFiles.text}`);
const merge = await req('PUT', `/api/v3/repos/adaiversen/demo/pulls/${prNum}/merge`, { merge_method: 'squash' });
check('REST merge PR 200', merge.status === 200 && merge.json?.merged === true && merge.json?.sha, `${merge.status} ${merge.text}`);
const mergeSha = merge.json?.sha;
const prAfter = await req('GET', `/api/v3/repos/adaiversen/demo/pulls/${prNum}`);
check('REST merged PR reads closed+merged', prAfter.status === 200 && prAfter.json?.state === 'closed' && prAfter.json?.merged === true && prAfter.json?.merge_commit_sha === mergeSha, `${prAfter.status} ${prAfter.text}`);
const featOnMain = await req('GET', '/api/v3/repos/adaiversen/demo/contents/feat.txt?ref=main');
check('REST merged file readable on main', featOnMain.status === 200 && featOnMain.json?.content === Buffer.from('feat\n').toString('base64'), `${featOnMain.status} ${featOnMain.text}`);
const mergeMissing = await req('PUT', '/api/v3/repos/adaiversen/demo/pulls/999/merge', {});
check('REST merge unknown PR 404', mergeMissing.status === 404, `${mergeMissing.status}`);

// conflict: two branches modify same file from same base
await req('POST', '/api/v3/repos/adaiversen/demo/git/refs', { ref: 'refs/heads/c1', sha: commits.json?.[0]?.sha });
await req('POST', '/api/v3/repos/adaiversen/demo/git/refs', { ref: 'refs/heads/c2', sha: commits.json?.[0]?.sha });
await req('PUT', '/api/v3/repos/adaiversen/demo/contents/conflict.txt', { message: 'c1', content: Buffer.from('c1\n').toString('base64'), branch: 'c1' });
await req('PUT', '/api/v3/repos/adaiversen/demo/contents/conflict.txt', { message: 'c2', content: Buffer.from('c2\n').toString('base64'), branch: 'c2' });
const prC1 = await req('POST', '/api/v3/repos/adaiversen/demo/pulls', { title: 'c1', head: 'c1', base: 'main' });
const prC2 = await req('POST', '/api/v3/repos/adaiversen/demo/pulls', { title: 'c2', head: 'c2', base: 'main' });
const m1 = await req('PUT', `/api/v3/repos/adaiversen/demo/pulls/${prC1.json?.number}/merge`, { merge_method: 'squash' });
const m2 = await req('PUT', `/api/v3/repos/adaiversen/demo/pulls/${prC2.json?.number}/merge`, { merge_method: 'squash' });
check('REST merge conflict 405', m1.status === 200 && m2.status === 405, `m1=${m1.status} m2=${m2.status} ${m2.text}`);

// delete repo
const delRepo = await req('DELETE', '/api/v3/repos/adaiversen/page-0');
check('REST delete repo 204', delRepo.status === 204, `${delRepo.status}`);
const getDeleted = await req('GET', '/api/v3/repos/adaiversen/page-0');
check('REST deleted repo 404', getDeleted.status === 404, `${getDeleted.status}`);

// ---- GraphQL ----
async function gql(body, token = TOKEN) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/graphql`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}

const gqlNoAuth = await gql({ query: '{ viewer { login } }' }, null);
check('GQL no auth exactly 401', gqlNoAuth.status === 401, `${gqlNoAuth.status}`);

const viewer = await gql({ query: 'query ViewerLogin { viewer { login } }' });
check('GQL viewer login', viewer.status === 200 && viewer.json?.data?.viewer?.login === 'adaiversen', viewer.text);

const repoFields = await gql({ query: 'query RepositoryFields { repository(owner: "adaiversen", name: "demo") { id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }' });
check('GQL repository fields', repoFields.status === 200 && repoFields.json?.data?.repository?.name === 'demo' && repoFields.json?.data?.repository?.databaseId > 0 && repoFields.json?.data?.repository?.viewerPermission === 'ADMIN', repoFields.text);
const repoId = repoFields.json?.data?.repository?.id;

const issueType = await gql({ query: 'query Issue_fields { __type(name: "Issue") { fields(includeDeprecated: true) { name } } }' });
const issueFieldNames = (issueType.json?.data?.__type?.fields ?? []).map((f) => f.name);
check('GQL Issue introspection', issueFieldNames.includes('id') && issueFieldNames.includes('number') && issueFieldNames.includes('title') && issueFieldNames.includes('state') && issueFieldNames.includes('body'), issueType.text);

const prType = await gql({ query: 'query PRFields { __type(name: "PullRequest") { fields(includeDeprecated: true) { name } } }' });
const prFieldNames = (prType.json?.data?.__type?.fields ?? []).map((f) => f.name);
check('GQL PullRequest introspection', ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].every((f) => prFieldNames.includes(f)), prType.text);

const searchType = await gql({ query: 'query SearchType_enumValues { __type(name: "SearchType") { enumValues { name } } }' });
const enumNames = (searchType.json?.data?.__type?.enumValues ?? []).map((e) => e.name);
check('GQL SearchType includes ISSUE', enumNames.includes('ISSUE'), searchType.text);

const openIssues = await gql({ query: 'query OpenIssues { repository(owner: "adaiversen", name: "demo") { issues(first: 10, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number title state id } } } }' });
const openNums = (openIssues.json?.data?.repository?.issues?.nodes ?? []).map((n) => n.number);
check('GQL open issues DESC', openIssues.status === 200 && openNums.length === 1 && openNums[0] === 2, openIssues.text);

const issueByNum = await gql({ query: 'query IssueByNumber { repository(owner: "adaiversen", name: "demo") { issue(number: 2) { number title state id body } } }' });
check('GQL issue by number', issueByNum.json?.data?.repository?.issue?.number === 2 && issueByNum.json?.data?.repository?.issue?.title === 'second issue', issueByNum.text);

const nodeRepo = await gql({ query: 'query NodeRepository { node(id: $id) { id ... on Repository { name nameWithOwner } } }', variables: { id: repoId } });
check('GQL node repository', nodeRepo.json?.data?.node?.name === 'demo' && nodeRepo.json?.data?.node?.nameWithOwner === 'adaiversen/demo', nodeRepo.text);

const badField = await gql({ query: 'query ViewerInvalidField { viewer { login noSuchFieldOnViewer } }' });
check('GQL unknown field 200 + errors mention field', badField.status === 200 && Array.isArray(badField.json?.errors) && /noSuchFieldOnViewer/.test(badField.json.errors[0]?.message ?? ''), badField.text);

const unknownRepo = await gql({ query: '{ repository(owner: "adaiversen", name: "nope") { name } }' });
check('GQL unknown repo null no errors', unknownRepo.json?.data?.repository === null && !unknownRepo.json?.errors, unknownRepo.text);

const batch = await gql([
  { query: '{ viewer { login } }' },
  { query: '{ repository(owner: "adaiversen", name: "demo") { name } }' },
]);
check('GQL batch two results in order', Array.isArray(batch.json) && batch.json[0]?.data?.viewer?.login === 'adaiversen' && batch.json[1]?.data?.repository?.name === 'demo', batch.text);

// GraphQL create issue + close issue
const gqlIssue = await gql({ query: 'mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { id number title state } } }', variables: { input: { repositoryId: repoId, title: 'gql issue', body: 'from gql' } } });
check('GQL createIssue', gqlIssue.json?.data?.createIssue?.issue?.title === 'gql issue', gqlIssue.text);
const gqlIssueId = gqlIssue.json?.data?.createIssue?.issue?.id;
const gqlClose = await gql({ query: 'mutation IssueClose($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number state } } }', variables: { input: { issueId: gqlIssueId } } });
check('GQL closeIssue', gqlClose.json?.data?.closeIssue?.issue?.state === 'CLOSED', gqlClose.text);

// ---- MCP ----
async function mcp(body, token = TOKEN, raw = false) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body: raw ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}

const mcpNoAuth = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, null);
check('MCP no auth 401', mcpNoAuth.status === 401, `${mcpNoAuth.status}`);

const discover = await mcp({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
check('MCP discover 2026-07-28', discover.status === 200 && (discover.json?.result?.supportedVersions ?? []).includes('2026-07-28'), discover.text);

const init = await mcp({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
check('MCP initialize', init.status === 200 && init.json?.result?.serverInfo?.name && init.json?.result?.capabilities?.tools, init.text);

const tools1 = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
const tools2 = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
const toolNames = (tools1.json?.result?.tools ?? []).map((t) => t.name);
check('MCP tools/list >=6 incl required', toolNames.length >= 6 && ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'].every((n) => toolNames.includes(n)), tools1.text);
check('MCP tools/list byte-identical', tools1.text === tools2.text, '');

const mcpCreateRepo = await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'mcp-repo' } } });
check('MCP create_repo', mcpCreateRepo.json?.result?.content?.[0]?.text?.includes('mcp-repo'), mcpCreateRepo.text);
const mcpGetRepo = await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_repo', arguments: { owner: 'adaiversen', repo: 'mcp-repo' } } });
check('MCP get_repo', mcpGetRepo.json?.result?.content?.[0]?.text?.includes('mcp-repo'), mcpGetRepo.text);
const mcpIssue = await mcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'mcp-repo', title: 'mcp issue', body: 'hi' } } });
check('MCP create_issue', mcpIssue.json?.result?.structuredContent?.number === 1, mcpIssue.text);
const mcpList = await mcp({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'list_issues', arguments: { owner: 'adaiversen', repo: 'mcp-repo' } } });
check('MCP list_issues contains title', mcpList.json?.result?.content?.[0]?.text?.includes('mcp issue'), mcpList.text);
const mcpUnknown = await mcp({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
check('MCP unknown tool -32602/-32601', [-32602, -32601].includes(mcpUnknown.json?.error?.code), mcpUnknown.text);
const mcpMissing = await mcp({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'mcp-repo' } } });
check('MCP missing arg isError or -32602', mcpMissing.json?.result?.isError === true || mcpMissing.json?.error?.code === -32602, mcpMissing.text);
const mcpParse = await mcp('{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"', TOKEN, true);
check('MCP parse error 400 -32700', mcpParse.status === 400 && mcpParse.json?.error?.code === -32700, `${mcpParse.status} ${mcpParse.text}`);
const mcpUnknownMethod = await mcp({ jsonrpc: '2.0', id: 11, method: 'nope/method', params: {} });
check('MCP unknown method -32601', mcpUnknownMethod.json?.error?.code === -32601, mcpUnknownMethod.text);

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length > 0) console.log('failures:', failures.join(', '));
process.exit(fail > 0 ? 1 : 0);
