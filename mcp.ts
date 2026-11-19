// MCP v4: JSON-RPC 2.0 Streamable HTTP on POST /mcp. Modern era first:
// server/discover (revision 2026-07-28), with a legacy initialize handshake
// as fallback. Tools act on the same store as REST and GraphQL.

import {
  FIXED_ISO, VIEWER_LOGIN, VIEWER_ID, tipOf, squashMerge,
  type PullRec, type Repo, type Store,
} from './store.ts';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'number', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Pull request state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
];

const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function serverInfoBlock(): Record<string, unknown> {
  return {
    name: 'github-core-clone',
    version: '1.0.0',
    title: 'GitHub-compatible git forge',
  };
}

function repoText(repo: Repo): string {
  return JSON.stringify({
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  });
}

function findTool(name: string): ToolDef | undefined {
  const lower = name.toLowerCase();
  return TOOLS.find((t) => lower === t.name || lower.endsWith(t.name));
}

function argString(args: Record<string, unknown>, names: string[]): string | undefined {
  for (const n of names) {
    const v = args[n];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

function argNumber(args: Record<string, unknown>, names: string[]): number | undefined {
  for (const n of names) {
    const v = args[n];
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  return undefined;
}

function textResult(text: string, structured?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    content: [{ type: 'text', text }],
  };
  if (structured !== undefined) out.structuredContent = structured;
  return out;
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function handleMcp(store: Store, body: unknown): { status: number; json: unknown } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  const req = body as Record<string, unknown>;
  const method = typeof req.method === 'string' ? req.method : '';
  const id = 'id' in req ? req.id : undefined;
  const params = (typeof req.params === 'object' && req.params !== null)
    ? (req.params as Record<string, unknown>) : {};
  const isNotification = id === undefined;

  const result = (value: unknown) => ({ status: 200, json: { jsonrpc: '2.0', id: id ?? null, result: value } });
  const error = (code: number, message: string) => ({
    status: 200,
    json: { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
  });

  if (method === 'ping') return result({});
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, json: null };
  }
  if (isNotification) return { status: 202, json: null };

  if (method === 'server/discover') {
    return result({
      serverInfo: serverInfoBlock(),
      capabilities: { tools: {} },
      supportedVersions: SUPPORTED_REVISIONS,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfoBlock() },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = SUPPORTED_REVISIONS.includes(offered) || LEGACY_REVISIONS.includes(offered)
      ? offered : '2025-11-25';
    return result({
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: serverInfoBlock(),
    });
  }

  if (method === 'tools/list') {
    // Built once, byte-identical on every call.
    return result({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = findTool(toolName);
    if (!tool) return error(-32602, `Unknown tool: ${toolName}`);
    const args = (typeof params.arguments === 'object' && params.arguments !== null)
      ? (params.arguments as Record<string, unknown>) : {};
    for (const reqd of tool.inputSchema.required) {
      if (args[reqd] === undefined || args[reqd] === null || args[reqd] === '') {
        return result(errorResult(`Missing required argument: ${reqd}`));
      }
    }
    return result(callTool(store, tool.name, args));
  }

  return error(-32601, `Method not found: ${method}`);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, ['name'])!;
      const description = argString(args, ['description']) ?? '';
      const isPrivate = args.private === true;
      const repo = store.createRepo(repoName, isPrivate, description);
      if (repo === null) return errorResult('Repository already exists');
      return textResult(repoText(repo), { name: repo.name, full_name: `${repo.owner}/${repo.name}` });
    }
    case 'get_repo': {
      const owner = argString(args, ['owner'])!;
      const repoName = argString(args, ['repo', 'repository', 'name'])!;
      const repo = store.findRepo(owner, repoName);
      if (!repo) return errorResult(`Repository not found: ${owner}/${repoName}`);
      return textResult(repoText(repo), { name: repo.name, full_name: `${repo.owner}/${repo.name}` });
    }
    case 'create_issue': {
      const owner = argString(args, ['owner'])!;
      const repoName = argString(args, ['repo', 'repository', 'name'])!;
      const title = argString(args, ['title'])!;
      const bodyText = argString(args, ['body']) ?? '';
      const repo = store.findRepo(owner, repoName);
      if (!repo) return errorResult(`Repository not found: ${owner}/${repoName}`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue = {
        id: store.nextId(), number, title, body: bodyText, state: 'open', labels: [] as string[], seq: number,
      };
      repo.issues.set(number, issue);
      const text = JSON.stringify({
        id: issue.id, number, title, body: bodyText, state: 'open',
        url: `https://example.invalid/${owner}/${repoName}/issues/${number}`,
        created_at: FIXED_ISO, updated_at: FIXED_ISO,
      });
      return textResult(text, { number, title, state: 'open' });
    }
    case 'list_issues': {
      const owner = argString(args, ['owner'])!;
      const repoName = argString(args, ['repo', 'repository', 'name'])!;
      const state = (argString(args, ['state']) ?? 'open').toLowerCase();
      const repo = store.findRepo(owner, repoName);
      if (!repo) return errorResult(`Repository not found: ${owner}/${repoName}`);
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      const text = JSON.stringify(list.map((i) => ({
        id: i.id, number: i.number, title: i.title, body: i.body, state: i.state,
      })));
      return textResult(text, { issues: list.map((i) => ({ number: i.number, title: i.title, state: i.state })) });
    }
    case 'create_pull_request': {
      const owner = argString(args, ['owner'])!;
      const repoName = argString(args, ['repo', 'repository', 'name'])!;
      const title = argString(args, ['title'])!;
      const head = argString(args, ['head', 'head_branch'])!;
      const base = argString(args, ['base', 'base_branch']) ?? 'main';
      const bodyText = argString(args, ['body']) ?? '';
      const repo = store.findRepo(owner, repoName);
      if (!repo) return errorResult(`Repository not found: ${owner}/${repoName}`);
      if (tipOf(repo, head) === undefined) return errorResult(`Head branch not found: ${head}`);
      if (tipOf(repo, base) === undefined) return errorResult(`Base branch not found: ${base}`);
      for (const p of repo.pulls.values()) {
        if (p.state === 'open' && p.head === head && p.base === base) {
          return errorResult('A pull request is already open');
        }
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pr = {
        id: store.nextId(), number, title, body: bodyText, state: 'open' as const,
        head, base, merged: false, mergeCommitSha: null, mergedAt: null, seq: number,
      };
      repo.pulls.set(number, pr);
      const text = JSON.stringify({
        id: pr.id, number, title, body: bodyText, state: 'open', head, base,
        url: `https://example.invalid/${owner}/${repoName}/pull/${number}`,
        created_at: FIXED_ISO, updated_at: FIXED_ISO,
      });
      return textResult(text, { number, pull_number: number, title, state: 'open' });
    }
    case 'merge_pull_request': {
      const owner = argString(args, ['owner'])!;
      const repoName = argString(args, ['repo', 'repository', 'name'])!;
      const number = argNumber(args, ['pull_number', 'pull_request_number', 'number'])!;
      const repo = store.findRepo(owner, repoName);
      if (!repo) return errorResult(`Repository not found: ${owner}/${repoName}`);
      const pr = repo.pulls.get(number);
      if (!pr) return errorResult(`Pull request not found: ${number}`);
      if (pr.merged || pr.state === 'closed') return errorResult('Pull request has already been merged');
      // Squash merge via the shared store helper through a local import-free path:
      const merged = mergePull(store, repo, pr);
      if (merged === null) return errorResult('Merge conflict');
      const text = JSON.stringify({ sha: merged, merged: true, message: 'Pull request successfully merged' });
      return textResult(text, { sha: merged, merged: true });
    }
    case 'get_issue': {
      const owner = argString(args, ['owner'])!;
      const repoName = argString(args, ['repo', 'repository', 'name'])!;
      const number = argNumber(args, ['issue_number', 'number'])!;
      const repo = store.findRepo(owner, repoName);
      if (!repo) return errorResult(`Repository not found: ${owner}/${repoName}`);
      const issue = repo.issues.get(number);
      if (!issue) return errorResult(`Issue not found: ${number}`);
      const text = JSON.stringify({
        id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state,
      });
      return textResult(text, { number: issue.number, title: issue.title, state: issue.state });
    }
    case 'list_pull_requests': {
      const owner = argString(args, ['owner'])!;
      const repoName = argString(args, ['repo', 'repository', 'name'])!;
      const state = (argString(args, ['state']) ?? 'open').toLowerCase();
      const repo = store.findRepo(owner, repoName);
      if (!repo) return errorResult(`Repository not found: ${owner}/${repoName}`);
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      const text = JSON.stringify(list.map((p) => ({
        id: p.id, number: p.number, title: p.title, state: p.state, head: p.head, base: p.base,
      })));
      return textResult(text, { pull_requests: list.map((p) => ({ number: p.number, title: p.title })) });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

function mergePull(store: Store, repo: Repo, pr: PullRec): string | null {
  void store;
  const result = squashMerge(repo, pr);
  if ('conflict' in result) return null;
  pr.merged = true;
  pr.state = 'closed';
  pr.mergeCommitSha = result.sha;
  pr.mergedAt = FIXED_ISO;
  return result.sha;
}
