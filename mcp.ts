// mcp.ts — Model Context Protocol (Streamable HTTP, revision 2026-07-28) over the forge.
// No session state: every request carries its own bearer token. The tools wrap the same
// store the REST and GraphQL surfaces use, so a repo made here is visible there.

import { globalId } from './rest.ts';
import { squashMergePullRequest, VIEWER, type Issue, type PullRequest, type Store } from './store.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
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
        owner: { type: 'string', description: 'Repository owner' },
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
        owner: { type: 'string', description: 'Repository owner' },
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
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all', enum: ['open', 'closed', 'all'] },
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
        owner: { type: 'string', description: 'Repository owner' },
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
    description: 'Merge a pull request (squash) in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
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
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Pull request state: open, closed or all', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function ok(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function error(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(data: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  const required = tool.inputSchema.required ?? [];
  return required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

export function handleMcp(store: Store, baseUrl: string, request: unknown): { status: number; body: unknown } {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 400, body: error(null, -32600, 'Invalid Request') };
  }
  const rpc = request as JsonRpcRequest;
  const id = rpc.id === undefined ? null : rpc.id;
  const method = rpc.method;

  // Notifications carry no id and expect no reply.
  if (id === null && typeof method === 'string' && method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (typeof method !== 'string') {
    return { status: 400, body: error(id, -32600, 'Invalid Request: method is required') };
  }

  switch (method) {
    case 'server/discover': {
      return {
        status: 200,
        body: ok(id, {
          supportedVersions: [PROTOCOL_VERSION, '2025-06-18', '2025-03-26'],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests and git over HTTP.',
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        }),
      };
    }
    case 'initialize': {
      const params = rpc.params ?? {};
      const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      return {
        status: 200,
        body: ok(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests and git over HTTP.',
        }),
      };
    }
    case 'ping': {
      return { status: 200, body: ok(id, {}) };
    }
    case 'tools/list': {
      return { status: 200, body: ok(id, { tools: TOOLS }) };
    }
    case 'tools/call': {
      const params = rpc.params ?? {};
      const rawName = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
      const tool = TOOLS.find((candidate) => {
        if (candidate.name === rawName) return true;
        const suffix = rawName.replace(/^github__/, '');
        return candidate.name === suffix;
      });
      if (tool === undefined) {
        return { status: 200, body: error(id, -32602, `Unknown tool: ${rawName}`) };
      }
      const missing = missingArgs(tool, args);
      if (missing.length > 0) {
        return {
          status: 200,
          body: ok(id, toolError(`Missing required argument(s): ${missing.join(', ')}`)),
        };
      }
      try {
        return { status: 200, body: ok(id, callTool(store, baseUrl, tool.name, args)) };
      } catch (err) {
        return { status: 200, body: ok(id, toolError(err instanceof Error ? err.message : 'Tool call failed')) };
      }
    }
    default: {
      if (method.startsWith('notifications/')) return { status: 202, body: null };
      return { status: 200, body: error(id, -32601, `Method not found: ${method}`) };
    }
  }
}

function callTool(store: Store, baseUrl: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = args.owner as string | undefined;
  const repoName = args.repo as string | undefined;

  switch (name) {
    case 'create_repo': {
      const repoNameArg = args.name as string;
      const existing = store.getRepo(VIEWER.login, repoNameArg);
      if (existing !== undefined) throw new Error('Repository already exists');
      const repo = store.createRepo(VIEWER.login, repoNameArg, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return toolResult({
        id: repo.dbId,
        node_id: globalId('Repository', repo.owner, repo.name),
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner, id: 1000 },
        description: repo.description,
        private: repo.isPrivate,
        default_branch: repo.defaultBranch,
        html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
      });
    }
    case 'get_repo': {
      const repo = store.getRepo(owner!, repoName!);
      if (repo === undefined) throw new Error('Repository not found');
      return toolResult({
        id: repo.dbId,
        node_id: globalId('Repository', repo.owner, repo.name),
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner, id: 1000 },
        description: repo.description,
        private: repo.isPrivate,
        default_branch: repo.defaultBranch,
        html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
      });
    }
    case 'create_issue': {
      const repo = store.getRepo(owner!, repoName!);
      if (repo === undefined) throw new Error('Repository not found');
      const now = new Date().toISOString();
      const issue: Issue = {
        id: store.globalId(),
        number: repo.nextNumber++,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: store.seq(),
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.set(issue.number, issue);
      return toolResult({
        id: issue.id,
        node_id: globalId('Issue', repo.owner, repo.name, issue.number),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
      });
    }
    case 'list_issues': {
      const repo = store.getRepo(owner!, repoName!);
      if (repo === undefined) throw new Error('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.createdSeq - a.createdSeq)
        .map((issue) => ({
          id: issue.id,
          node_id: globalId('Issue', repo.owner, repo.name, issue.number),
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
        }));
      return toolResult({ issues, total_count: issues.length });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner!, repoName!);
      if (repo === undefined) throw new Error('Repository not found');
      const head = args.head as string;
      const base = args.base as string;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) throw new Error('head or base branch not found');
      const now = new Date().toISOString();
      const pull: PullRequest = {
        id: store.globalId(),
        number: repo.nextNumber++,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        head,
        base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: store.seq(),
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.pulls.set(pull.number, pull);
      return toolResult({
        id: pull.id,
        node_id: globalId('PullRequest', repo.owner, repo.name, pull.number),
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.head, sha: pull.headSha },
        base: { ref: pull.base, sha: pull.baseSha },
        html_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
      });
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner!, repoName!);
      if (repo === undefined) throw new Error('Repository not found');
      const number = args.pull_number as number;
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new Error('Pull request not found');
      const outcome = squashMergePullRequest(store, repo, pull, 'squash');
      if ('error' in outcome) throw new Error(outcome.error);
      return toolResult({
        id: pull.id,
        node_id: globalId('PullRequest', repo.owner, repo.name, pull.number),
        number: pull.number,
        title: pull.title,
        state: pull.state,
        merged: pull.merged,
        merge_commit_sha: pull.mergeCommitSha,
        sha: pull.mergeCommitSha,
        html_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
      });
    }
    case 'get_issue': {
      const repo = store.getRepo(owner!, repoName!);
      if (repo === undefined) throw new Error('Repository not found');
      const issue = repo.issues.get(args.issue_number as number);
      if (issue === undefined) throw new Error('Issue not found');
      return toolResult({
        id: issue.id,
        node_id: globalId('Issue', repo.owner, repo.name, issue.number),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
      });
    }
    case 'list_pull_requests': {
      const repo = store.getRepo(owner!, repoName!);
      if (repo === undefined) throw new Error('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const pulls = [...repo.pulls.values()]
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => b.createdSeq - a.createdSeq)
        .map((pull) => ({
          id: pull.id,
          node_id: globalId('PullRequest', repo.owner, repo.name, pull.number),
          number: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          merged: pull.merged,
          head: { ref: pull.head, sha: pull.headSha },
          base: { ref: pull.base, sha: pull.baseSha },
          html_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
        }));
      return toolResult({ pull_requests: pulls, total_count: pulls.length });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
