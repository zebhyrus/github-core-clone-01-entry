// GraphQL v4: a small parser and executor for the documents gh and
// github-mcp-server send. No wall clock, no randomness; ids are deterministic.

import {
  FIXED_ISO, VIEWER_LOGIN, prFiles, prMergeable, squashMerge, tipOf,
  type IssueRec, type PullRec, type Repo, type Store,
} from './store.ts';

// ---------------------------------------------------------------- parser

export type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'enum'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selections: SelectionNode[];
}

export type SelectionNode =
  | FieldNode
  | { kind: 'fragment'; typeCondition: string | null; selections: SelectionNode[] };

export interface Operation {
  opType: 'query' | 'mutation';
  name: string | null;
  varDefs: Array<{ name: string; type: string; required: boolean }>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  private skipWs(): void {
    for (;;) {
      // GraphQL treats commas as insignificant separators, like whitespace.
      while (this.pos < this.src.length && (/[\s,]/.test(this.src[this.pos]!))) this.pos += 1;
      if (this.src[this.pos] === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    this.skipWs();
    return this.src[this.pos] ?? '';
  }

  private expect(ch: string): void {
    this.skipWs();
    if (this.src[this.pos] !== ch) throw new Error(`expected ${ch} at ${this.pos}`);
    this.pos += 1;
  }

  private readName(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }

  private readString(): string {
    this.expect('"');
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;
      if (ch === '"') { this.pos += 1; return out; }
      if (ch === '\\') {
        this.pos += 1;
        const esc = this.src[this.pos]!;
        this.pos += 1;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === 'u') { out += String.fromCharCode(parseInt(this.src.slice(this.pos, this.pos + 4), 16)); this.pos += 4; }
        else out += esc;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    throw new Error('unterminated string');
  }

  parseValue(): GqlValue {
    this.skipWs();
    const ch = this.src[this.pos]!;
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'var', name: this.readName() };
    }
    if (ch === '"') return { kind: 'string', value: this.readString() };
    if (ch === '[') {
      this.pos += 1;
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek() !== '}') {
        const name = this.readName();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
      if (!m) throw new Error('bad number');
      this.pos += m[0].length;
      const v = Number(m[0]);
      return m[0].includes('.') || /[eE]/.test(m[0]) ? { kind: 'float', value: v } : { kind: 'int', value: v };
    }
    const name = this.readName();
    if (name === 'true') return { kind: 'bool', value: true };
    if (name === 'false') return { kind: 'bool', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  parseArgs(): Array<{ name: string; value: GqlValue }> {
    const args: Array<{ name: string; value: GqlValue }> = [];
    this.skipWs();
    if (this.src[this.pos] !== '(') return args;
    this.pos += 1;
    while (this.peek() !== ')') {
      const name = this.readName();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect(')');
    return args;
  }

  parseSelections(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.src.slice(this.pos, this.pos + 3) === '...') {
        this.pos += 3;
        this.skipWs();
        let typeCondition: string | null = null;
        if (this.src.slice(this.pos, this.pos + 2) === 'on') {
          this.pos += 2;
          typeCondition = this.readName();
        } else {
          // named fragment spread: resolve by name (fragments are stored by the document parser)
          const fragName = this.readName();
          const frag = this.fragments.get(fragName);
          if (frag) out.push(...frag);
          continue;
        }
        out.push({ kind: 'fragment', typeCondition, selections: this.parseSelections() });
        continue;
      }
      const first = this.readName();
      let alias: string | null = null;
      let name = first;
      this.skipWs();
      if (this.src[this.pos] === ':') {
        this.pos += 1;
        alias = first;
        name = this.readName();
      }
      const args = this.parseArgs();
      let selections: SelectionNode[] = [];
      this.skipWs();
      if (this.src[this.pos] === '{') selections = this.parseSelections();
      out.push({ kind: 'field', alias, name, args, selections });
    }
    this.expect('}');
    return out;
  }

  fragments = new Map<string, SelectionNode[]>();

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek() !== '') {
      this.skipWs();
      if (this.pos >= this.src.length) break;
      if (this.src[this.pos] === '{') {
        ops.push({ opType: 'query', name: null, varDefs: [], selections: this.parseSelections() });
        continue;
      }
      const keyword = this.readName();
      if (keyword === 'fragment') {
        const name = this.readName();
        this.skipWs();
        if (this.src.slice(this.pos, this.pos + 2) === 'on') {
          this.pos += 2;
          this.readName();
        }
        this.fragments.set(name, this.parseSelections());
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
        throw new Error(`unknown operation ${keyword}`);
      }
      this.skipWs();
      let name: string | null = null;
      if (/[A-Za-z_]/.test(this.src[this.pos] ?? '')) name = this.readName();
      const varDefs: Operation['varDefs'] = [];
      this.skipWs();
      if (this.src[this.pos] === '(') {
        this.pos += 1;
        while (this.peek() !== ')') {
          this.skipWs();
          if (this.src[this.pos] === '$') this.pos += 1;
          const vname = this.readName();
          this.expect(':');
          let type = '';
          this.skipWs();
          if (this.src[this.pos] === '[') {
            this.pos += 1;
            type = `[${this.readName()}]`;
            this.skipWs();
            if (this.src[this.pos] === ']') this.pos += 1;
          } else {
            type = this.readName();
          }
          let required = false;
          this.skipWs();
          if (this.src[this.pos] === '!') { required = true; this.pos += 1; }
          // skip a default value if present
          this.skipWs();
          if (this.src[this.pos] === '=') { this.pos += 1; this.parseValue(); }
          varDefs.push({ name: vname, type, required });
        }
        this.expect(')');
      }
      ops.push({ opType: keyword as 'query' | 'mutation', name, varDefs, selections: this.parseSelections() });
    }
    return ops;
  }
}

export function parseDocument(src: string): Operation[] {
  return new Parser(src).parseDocument();
}

// ---------------------------------------------------------------- executor

type Variables = Record<string, unknown>;

function resolveValue(v: GqlValue, vars: Variables): unknown {
  switch (v.kind) {
    case 'var': return vars[v.name];
    case 'string': return v.value;
    case 'int': case 'float': return v.value;
    case 'enum': return v.value;
    case 'bool': return v.value;
    case 'null': return null;
    case 'list': return v.items.map((i) => resolveValue(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = resolveValue(f.value, vars);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, vars: Variables): unknown {
  const arg = field.args.find((a) => a.name === name);
  return arg === undefined ? undefined : resolveValue(arg.value, vars);
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'mergeCommit', 'isDraft'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Ref: ['name', 'target'],
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  SearchType: [],
};

const SEARCH_ENUMS = ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'PACKAGE', 'MARKETPLACE'];

interface Ctx {
  store: Store;
  vars: Variables;
  errors: Array<{ message: string }>;
}

type Node =
  | { __typename: 'Query' }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: IssueRec }
  | { __typename: 'PullRequest'; repo: Repo; pr: PullRec }
  | { __typename: 'User'; login: string }
  | { __typename: 'IssueConnection'; repo: Repo; issues: IssueRec[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'PullRequestConnection'; repo: Repo; prs: PullRec[] }
  | { __typename: 'PullRequestChangedFileConnection'; repo: Repo; pr: PullRec }
  | { __typename: 'PullRequestChangedFile'; path: string; additions: number; deletions: number }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Type'; name: string }
  | { __typename: 'MutationResult'; value: Record<string, unknown> }
  | { __typename: 'MutationRoot' };

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function repoIssuesOrdered(repo: Repo, states: string[] | undefined, orderDesc: boolean): IssueRec[] {
  let list = [...repo.issues.values()];
  if (states && states.length > 0) {
    const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s.toLowerCase())));
    list = list.filter((i) => wanted.has(i.state));
  }
  list.sort((a, b) => (orderDesc ? b.number - a.number : a.number - b.number));
  return list;
}

function executeSelections(node: Node, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition !== null && sel.typeCondition !== node.__typename) continue;
      Object.assign(out, executeSelections(node, sel.selections, ctx));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const value = resolveField(node, sel, ctx);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function unknownField(node: Node, field: FieldNode, ctx: Ctx): null {
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${node.__typename}".` });
  return null;
}

function resolveField(node: Node, field: FieldNode, ctx: Ctx): unknown {
  const name = field.name;
  switch (node.__typename) {
    case 'Query': {
      if (name === 'viewer') {
        return executeSelections({ __typename: 'User', login: VIEWER_LOGIN }, field.selections, ctx);
      }
      if (name === 'repository') {
        const owner = argValue(field, 'owner', ctx.vars);
        const repoName = argValue(field, 'name', ctx.vars);
        const repo = typeof owner === 'string' && typeof repoName === 'string'
          ? ctx.store.findRepo(owner, repoName) : undefined;
        if (!repo) return null;
        return executeSelections({ __typename: 'Repository', repo }, field.selections, ctx);
      }
      if (name === 'node') {
        const id = argValue(field, 'id', ctx.vars);
        if (typeof id !== 'string') return null;
        const parsed = ctx.store.parseGlobalId(id);
        if (!parsed) return null;
        const repo = ctx.store.findRepoById(parsed.repoId);
        if (!repo) return null;
        if (parsed.kind === 'repo') {
          return executeSelections({ __typename: 'Repository', repo }, field.selections, ctx);
        }
        if (parsed.kind === 'issue') {
          const issue = repo.issues.get(parsed.num);
          if (!issue) return null;
          return executeSelections({ __typename: 'Issue', repo, issue }, field.selections, ctx);
        }
        if (parsed.kind === 'pr') {
          const pr = repo.pulls.get(parsed.num);
          if (!pr) return null;
          return executeSelections({ __typename: 'PullRequest', repo, pr }, field.selections, ctx);
        }
        return null;
      }
      if (name === '__type') {
        const typeName = argValue(field, 'name', ctx.vars);
        if (typeof typeName !== 'string') return null;
        if (!(typeName in TYPE_FIELDS) && typeName !== 'SearchType') return null;
        return executeSelections({ __typename: 'Type', name: typeName }, field.selections, ctx);
      }
      if (name === '__schema') return null;
      return unknownField(node, field, ctx);
    }
    case 'User': {
      if (name === 'login') return node.login;
      if (name === 'id') return Buffer.from(`user:${node.login}`, 'utf8').toString('base64url');
      if (name === 'name') return node.login;
      return unknownField(node, field, ctx);
    }
    case 'Type': {
      if (name === 'name') return node.name;
      if (name === 'fields') {
        const fields = TYPE_FIELDS[node.name] ?? [];
        return fields.map((f) => ({ name: f }));
      }
      if (name === 'enumValues') {
        if (node.name === 'SearchType') return SEARCH_ENUMS.map((e) => ({ name: e }));
        return [];
      }
      if (name === 'kind') return node.name === 'SearchType' ? 'ENUM' : 'OBJECT';
      return unknownField(node, field, ctx);
    }
    case 'Repository': {
      const repo = node.repo;
      switch (name) {
        case 'id': return ctx.store.globalId('repo', repo.id, 0);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'owner': return executeSelections({ __typename: 'User', login: repo.owner }, field.selections, ctx);
        case 'defaultBranchRef': {
          const tip = tipOf(repo, repo.defaultBranch);
          if (tip === undefined) return null;
          return executeSelections({ __typename: 'Ref', name: repo.defaultBranch }, field.selections, ctx);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'url': return `https://example.invalid/${repo.owner}/${repo.name}`;
        case 'createdAt': case 'updatedAt': return FIXED_ISO;
        case 'issue': {
          const number = argValue(field, 'number', ctx.vars);
          if (typeof number !== 'number') return null;
          const issue = repo.issues.get(number);
          if (!issue) return null;
          return executeSelections({ __typename: 'Issue', repo, issue }, field.selections, ctx);
        }
        case 'issues': {
          const first = argValue(field, 'first', ctx.vars);
          const after = argValue(field, 'after', ctx.vars);
          const states = argValue(field, 'states', ctx.vars);
          const orderBy = argValue(field, 'orderBy', ctx.vars) as Record<string, unknown> | undefined;
          let orderDesc = true;
          if (orderBy && typeof orderBy.direction === 'string') orderDesc = orderBy.direction === 'DESC';
          const ordered = repoIssuesOrdered(repo, Array.isArray(states) ? (states as string[]) : undefined, orderDesc);
          const afterNum = cursorNumber(typeof after === 'string' ? after : null);
          let filtered = ordered;
          if (afterNum !== null) {
            filtered = orderDesc ? ordered.filter((i) => i.number < afterNum) : ordered.filter((i) => i.number > afterNum);
          }
          const limit = typeof first === 'number' ? first : filtered.length;
          const page = filtered.slice(0, limit);
          const hasNext = filtered.length > page.length;
          const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
          return executeSelections(
            { __typename: 'IssueConnection', repo, issues: page, pageInfo: { hasNextPage: hasNext, endCursor } },
            field.selections, ctx,
          );
        }
        case 'pullRequests': {
          const first = argValue(field, 'first', ctx.vars);
          let prs = [...repo.pulls.values()].filter((p) => p.state === 'open');
          prs.sort((a, b) => a.number - b.number);
          if (typeof first === 'number') prs = prs.slice(0, first);
          return executeSelections({ __typename: 'PullRequestConnection', repo, prs }, field.selections, ctx);
        }
        case 'pullRequest': {
          const number = argValue(field, 'number', ctx.vars);
          if (typeof number !== 'number') return null;
          const pr = repo.pulls.get(number);
          if (!pr) return null;
          return executeSelections({ __typename: 'PullRequest', repo, pr }, field.selections, ctx);
        }
        default: return unknownField(node, field, ctx);
      }
    }
    case 'Issue': {
      const issue = node.issue;
      switch (name) {
        case 'id': return ctx.store.globalId('issue', node.repo.id, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body ?? '';
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'url': return `https://example.invalid/${node.repo.owner}/${node.repo.name}/issues/${issue.number}`;
        case 'createdAt': case 'updatedAt': return FIXED_ISO;
        case 'author': return executeSelections({ __typename: 'User', login: VIEWER_LOGIN }, field.selections, ctx);
        case 'labels': return issue.labels.map((l) => ({ name: l }));
        case 'comments': return { totalCount: (node.repo.comments.get(issue.number) ?? []).length };
        default: return unknownField(node, field, ctx);
      }
    }
    case 'PullRequest': {
      const pr = node.pr;
      switch (name) {
        case 'id': return ctx.store.globalId('pr', node.repo.id, pr.number);
        case 'number': return pr.number;
        case 'title': return pr.title;
        case 'body': return pr.body ?? '';
        case 'state': return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return pr.merged;
        case 'mergeable': return prMergeable(node.repo, pr) ? 'MERGEABLE' : 'CONFLICTING';
        case 'headRefName': return pr.head;
        case 'baseRefName': return pr.base;
        case 'headRef': return executeSelections({ __typename: 'Ref', name: pr.head }, field.selections, ctx);
        case 'baseRef': return executeSelections({ __typename: 'Ref', name: pr.base }, field.selections, ctx);
        case 'url': return `https://example.invalid/${node.repo.owner}/${node.repo.name}/pull/${pr.number}`;
        case 'createdAt': case 'updatedAt': return FIXED_ISO;
        case 'author': return executeSelections({ __typename: 'User', login: VIEWER_LOGIN }, field.selections, ctx);
        case 'files': {
          return executeSelections(
            { __typename: 'PullRequestChangedFileConnection', repo: node.repo, pr }, field.selections, ctx);
        }
        case 'mergeCommit': {
          if (!pr.mergeCommitSha) return null;
          return { oid: pr.mergeCommitSha };
        }
        case 'isDraft': return false;
        default: return unknownField(node, field, ctx);
      }
    }
    case 'IssueConnection': {
      if (name === 'nodes') {
        return node.issues.map((issue) => executeSelections({ __typename: 'Issue', repo: node.repo, issue }, field.selections, ctx));
      }
      if (name === 'edges') {
        return node.issues.map((issue) => ({
          node: executeSelections({ __typename: 'Issue', repo: node.repo, issue }, field.selections, ctx),
          cursor: cursorFor(issue.number),
        }));
      }
      if (name === 'pageInfo') {
        return executeSelections({ __typename: 'PageInfo', hasNextPage: node.pageInfo.hasNextPage, endCursor: node.pageInfo.endCursor }, field.selections, ctx);
      }
      if (name === 'totalCount') return node.issues.length;
      return unknownField(node, field, ctx);
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') {
        return node.prs.map((pr) => executeSelections({ __typename: 'PullRequest', repo: node.repo, pr }, field.selections, ctx));
      }
      if (name === 'edges') {
        return node.prs.map((pr) => ({
          node: executeSelections({ __typename: 'PullRequest', repo: node.repo, pr }, field.selections, ctx),
          cursor: cursorFor(pr.number),
        }));
      }
      if (name === 'pageInfo') {
        return executeSelections({ __typename: 'PageInfo', hasNextPage: false, endCursor: null }, field.selections, ctx);
      }
      if (name === 'totalCount') return node.prs.length;
      return unknownField(node, field, ctx);
    }
    case 'PullRequestChangedFileConnection': {
      if (name === 'nodes') {
        const files = prFiles(node.repo, node.pr);
        return files.map((f) => executeSelections(
          { __typename: 'PullRequestChangedFile', path: f.path, additions: f.additions, deletions: f.deletions },
          field.selections, ctx));
      }
      if (name === 'pageInfo') {
        return executeSelections({ __typename: 'PageInfo', hasNextPage: false, endCursor: null }, field.selections, ctx);
      }
      if (name === 'totalCount') return prFiles(node.repo, node.pr).length;
      return unknownField(node, field, ctx);
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return node.path;
      if (name === 'additions') return node.additions;
      if (name === 'deletions') return node.deletions;
      if (name === 'changeType') return 'MODIFIED';
      return unknownField(node, field, ctx);
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return node.hasNextPage;
      if (name === 'hasPreviousPage') return false;
      if (name === 'endCursor') return node.endCursor;
      if (name === 'startCursor') return null;
      return unknownField(node, field, ctx);
    }
    case 'Ref': {
      if (name === 'name') return node.name;
      if (name === 'target') return { oid: '' };
      return unknownField(node, field, ctx);
    }
    case 'MutationResult': {
      const v = node.value[field.name];
      if (v === undefined) return unknownField(node, field, ctx);
      if (field.selections.length > 0 && v !== null && typeof v === 'object' && '__node' in (v as Record<string, unknown>)) {
        const inner = (v as Record<string, unknown>).__node as Node;
        return executeSelections(inner, field.selections, ctx);
      }
      return v;
    }
    case 'MutationRoot': {
      const result = runMutation(node, field, ctx);
      if (result === null) return null;
      return executeSelections(result, field.selections, ctx);
    }
  }
}

// ---------------------------------------------------------------- mutations

function createIssueRec(store: Store, repo: Repo, title: string, body: string, labels: string[] = []): IssueRec {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: IssueRec = { id: store.nextId(), number, title, body, state: 'open', labels, seq: number };
  repo.issues.set(number, issue);
  return issue;
}

function createPullRec(store: Store, repo: Repo, title: string, body: string, head: string, base: string): PullRec | null {
  if (tipOf(repo, head) === undefined || tipOf(repo, base) === undefined) return null;
  for (const p of repo.pulls.values()) {
    if (p.state === 'open' && p.head === head && p.base === base) return null;
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pr: PullRec = {
    id: store.nextId(), number, title, body, state: 'open',
    head, base, merged: false, mergeCommitSha: null, mergedAt: null, seq: number,
  };
  repo.pulls.set(number, pr);
  return pr;
}

function repoFromGlobalId(ctx: Ctx, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = ctx.store.parseGlobalId(id);
  if (!parsed || parsed.kind !== 'repo') return null;
  return ctx.store.findRepoById(parsed.repoId) ?? null;
}

function runMutation(node: { __typename: 'MutationRoot' }, field: FieldNode, ctx: Ctx): Node | null {
  void node;
  const input = argValue(field, 'input', ctx.vars) as Record<string, unknown> | undefined;
  if (field.name === 'createIssue') {
    const repo = repoFromGlobalId(ctx, input?.repositoryId);
    if (!repo) return null;
    const title = typeof input?.title === 'string' ? input.title : '';
    const body = typeof input?.body === 'string' ? input.body : '';
    const issue = createIssueRec(ctx.store, repo, title, body);
    return { __typename: 'MutationResult', value: { issue: { __node: { __typename: 'Issue', repo, issue } as Node } } };
  }
  if (field.name === 'closeIssue') {
    const id = input?.issueId;
    if (typeof id !== 'string') return null;
    const parsed = ctx.store.parseGlobalId(id);
    if (!parsed || parsed.kind !== 'issue') return null;
    const repo = ctx.store.findRepoById(parsed.repoId);
    const issue = repo?.issues.get(parsed.num);
    if (!repo || !issue) return null;
    issue.state = 'closed';
    return { __typename: 'MutationResult', value: { issue: { __node: { __typename: 'Issue', repo, issue } as Node } } };
  }
  if (field.name === 'createPullRequest') {
    const repo = repoFromGlobalId(ctx, input?.repositoryId);
    if (!repo) return null;
    const head = typeof input?.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input?.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
    const title = typeof input?.title === 'string' ? input.title : '';
    const body = typeof input?.body === 'string' ? input.body : '';
    const pr = createPullRec(ctx.store, repo, title, body, head, base);
    if (!pr) return null;
    return { __typename: 'MutationResult', value: { pullRequest: { __node: { __typename: 'PullRequest', repo, pr } as Node } } };
  }
  if (field.name === 'mergePullRequest') {
    const id = input?.pullRequestId;
    if (typeof id !== 'string') return null;
    const parsed = ctx.store.parseGlobalId(id);
    if (!parsed || parsed.kind !== 'pr') return null;
    const repo = ctx.store.findRepoById(parsed.repoId);
    const pr = repo?.pulls.get(parsed.num);
    if (!repo || !pr) return null;
    if (!pr.merged && pr.state === 'open') {
      const result = squashMerge(repo, pr);
      if ('conflict' in result) {
        ctx.errors.push({ message: 'Merge conflict' });
        return { __typename: 'MutationResult', value: { pullRequest: { __node: { __typename: 'PullRequest', repo, pr } as Node } } };
      }
      pr.merged = true;
      pr.state = 'closed';
      pr.mergeCommitSha = result.sha;
      pr.mergedAt = '2025-01-01T00:00:00Z';
    }
    return { __typename: 'MutationResult', value: { pullRequest: { __node: { __typename: 'PullRequest', repo, pr } as Node } } };
  }
  if (field.name === 'addComment') {
    const id = input?.subjectId;
    const body = typeof input?.body === 'string' ? input.body : '';
    if (typeof id !== 'string') return null;
    const parsed = ctx.store.parseGlobalId(id);
    if (!parsed || parsed.kind !== 'issue') return null;
    const repo = ctx.store.findRepoById(parsed.repoId);
    const issue = repo?.issues.get(parsed.num);
    if (!repo || !issue) return null;
    const commentId = ctx.store.nextId();
    const list = repo.comments.get(issue.number) ?? [];
    list.push({ id: commentId, body, seq: commentId });
    repo.comments.set(issue.number, list);
    const commentNodeId = Buffer.from(`comment:${repo.id}:${issue.number}:${commentId}`, 'utf8').toString('base64url');
    return { __typename: 'MutationResult', value: { commentEdge: { node: { id: commentNodeId, body } } } };
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

// ---------------------------------------------------------------- entry point

export function executeOperation(store: Store, op: Operation, vars: Variables): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const ctx: Ctx = { store, vars, errors: [] };
  const root: Node = op.opType === 'mutation' ? { __typename: 'MutationRoot' } : { __typename: 'Query' };
  const data = executeSelections(root, op.selections, ctx);
  return { data, errors: ctx.errors };
}

export function handleGraphQL(store: Store, body: unknown): { status: number; json: unknown } {
  const ops: Array<{ query: string; variables: Variables }> = [];
  if (Array.isArray(body)) {
    for (const item of body) {
      if (typeof item === 'object' && item !== null) {
        ops.push({
          query: typeof (item as Record<string, unknown>).query === 'string' ? (item as Record<string, unknown>).query as string : '',
          variables: ((item as Record<string, unknown>).variables as Variables) ?? {},
        });
      }
    }
  } else if (typeof body === 'object' && body !== null) {
    ops.push({
      query: typeof (body as Record<string, unknown>).query === 'string' ? (body as Record<string, unknown>).query as string : '',
      variables: ((body as Record<string, unknown>).variables as Variables) ?? {},
    });
  } else {
    return { status: 400, json: { errors: [{ message: 'GraphQL request body must be an object' }] } };
  }
  const results: unknown[] = [];
  for (const { query, variables } of ops) {
    let parsed: Operation[];
    try {
      parsed = parseDocument(query);
    } catch (e) {
      results.push({ data: null, errors: [{ message: e instanceof Error ? e.message : 'Syntax error' }] });
      continue;
    }
    if (parsed.length === 0) {
      results.push({ data: null, errors: [{ message: 'Empty query' }] });
      continue;
    }
    // One operation per document in the suite's usage; answer the first.
    const op = parsed[0]!;
    const { data, errors } = executeOperation(store, op, variables);
    const out: Record<string, unknown> = { data };
    if (errors.length > 0) out.errors = errors;
    results.push(out);
  }
  if (Array.isArray(body)) return { status: 200, json: results };
  return { status: 200, json: results[0] };
}

