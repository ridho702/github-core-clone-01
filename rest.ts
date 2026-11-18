// rest.ts — the GitHub REST v3 surface: repositories, branches, commits, contents,
// labels, issues and pull requests. Every reply is JSON; every error carries {message}.

import { commitHistory, mergeBase, parseCommit, parseTree, putObject } from './git.ts';
import {
  diffFiles,
  squashMergePullRequest,
  VIEWER,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestContext {
  store: Store;
  method: string;
  /** Path segments, percent-decoded, without the leading /api/v3. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body (undefined when there was no body). */
  body: unknown;
  /** False when a body was present but was not valid JSON. */
  bodyValid: boolean;
  /** The request carried the entry's bearer token. */
  authed: boolean;
  /** The entry's origin, for absolute Link URLs. */
  baseUrl: string;
}

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** An opaque Relay-style global id (never the plain database id or number). */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join('/')}`, 'utf8').toString('base64');
}

function err(status: number, message: string): RestReply {
  return { status, body: { message } };
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

/** Parse per_page/page and slice a list, answering the Link header when there are more pages. */
function paginate<T>(ctx: RestContext, path: string, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, num(ctx.query.get('per_page'), 30)));
  const pageNum = Math.max(1, num(ctx.query.get('page'), 1));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (totalPages > 1) {
    const url = (page: number): string => `${ctx.baseUrl}${path}?per_page=${perPage}&page=${page}`;
    const links: string[] = [];
    if (pageNum < totalPages) links.push(`<${url(pageNum + 1)}>; rel="next"`);
    if (pageNum > 1) links.push(`<${url(pageNum - 1)}>; rel="prev"`);
    links.push(`<${url(1)}>; rel="first"`);
    links.push(`<${url(totalPages)}>; rel="last"`);
    headers.link = links.join(', ');
  }
  return { page, headers };
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

function userJson(login: string, id: number): Json {
  return { login, id, node_id: globalId('User', login), avatar_url: '', type: 'User', site_admin: false };
}

function repoJson(ctx: RestContext, repo: Repo): Json {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  const openPulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: repo.dbId,
    node_id: globalId('Repository', repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, VIEWER.id),
    private: repo.isPrivate,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues + openPulls,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(ctx: RestContext, repo: Repo, label: Label): Json {
  return {
    id: label.id,
    node_id: globalId('Label', repo.owner, repo.name, label.name),
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueJson(ctx: RestContext, repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.owner, repo.name, issue.number),
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(VIEWER.login, VIEWER.id),
    labels: issue.labels.map((label) => labelJson(ctx, repo, label)),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function commentJson(ctx: RestContext, repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string }): Json {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.owner, repo.name, issueNumber, comment.id),
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    author_association: 'OWNER',
  };
}

function pullJson(ctx: RestContext, repo: Repo, pull: PullRequest): Json {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.owner, repo.name, pull.number),
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.state === 'open',
    mergeable_state: pull.state === 'open' ? 'clean' : 'unknown',
    merged_by: pull.merged ? userJson(VIEWER.login, VIEWER.id) : null,
    head: {
      label: `${repo.owner}:${pull.head}`,
      ref: pull.head,
      sha: pull.headSha,
      user: userJson(repo.owner, VIEWER.id),
      repo: repoJson(ctx, repo),
    },
    base: {
      label: `${repo.owner}:${pull.base}`,
      ref: pull.base,
      sha: pull.baseSha,
      user: userJson(repo.owner, VIEWER.id),
      repo: repoJson(ctx, repo),
    },
    author_association: 'OWNER',
    draft: false,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

// ---------------------------------------------------------------------------
// Repository helpers
// ---------------------------------------------------------------------------

/** The repository a route names, or the 404 reply when it is absent or foreign. */
function lookupRepo(ctx: RestContext, owner: string, name: string): Repo | RestReply {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  return repo;
}

function requireBodyObject(ctx: RestContext): Json | RestReply {
  if (!ctx.bodyValid) return err(400, 'Problems parsing JSON');
  if (ctx.body === undefined) return {};
  if (!isRecord(ctx.body)) return err(400, 'Problems parsing JSON');
  return ctx.body;
}

/** True when a requireBodyObject result is an error reply rather than the parsed body. */
function isRestReply(value: Json | RestReply): value is RestReply {
  return typeof (value as RestReply).status === 'number';
}

/** A new commit on `branch` with one file set, returning its sha. */
function commitContentChange(
  ctx: RestContext,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { sha: string; blobSha: string | null } | RestReply {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const files = tip === undefined ? new Map<string, { oid: string; mode: string }>() : ctx.store.filesAt(repo, tip);
  let blobSha: string | null = null;
  if (content === null) {
    files.delete(path);
  } else {
    blobSha = putObject(repo.objects, 'blob', content);
    files.set(path, { oid: blobSha, mode: '100644' });
  }
  const sha = ctx.store.commitFiles(repo, branch, files, message, tip === undefined ? null : undefined);
  repo.updatedAt = new Date().toISOString();
  repo.pushedAt = repo.updatedAt;
  return { sha, blobSha };
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function handleRest(ctx: RestContext): RestReply {
  const { method } = ctx;
  const seg = ctx.segments;

  // The API root and meta are public; everything else needs the bearer token.
  if (method === 'GET' && seg.length === 0) {
    return ok(
      {
        current_user_url: `${ctx.baseUrl}/api/v3/user`,
        current_user_authorizations_html_url: 'https://github.com/settings/applications',
        authorizations_url: `${ctx.baseUrl}/api/v3/authorizations`,
        code_search_url: `${ctx.baseUrl}/api/v3/search/code?q={query}`,
        commit_search_url: `${ctx.baseUrl}/api/v3/search/commits?q={query}`,
        emails_url: `${ctx.baseUrl}/api/v3/user/emails`,
        emojis_url: `${ctx.baseUrl}/api/v3/emojis`,
        events_url: `${ctx.baseUrl}/api/v3/events`,
        feeds_url: `${ctx.baseUrl}/api/v3/feeds`,
        followers_url: `${ctx.baseUrl}/api/v3/users/{user}/followers`,
        following_url: `${ctx.baseUrl}/api/v3/users/{user}/following{/other_user}`,
        gists_url: `${ctx.baseUrl}/api/v3/gists{/gist_id}`,
        hub_url: `${ctx.baseUrl}/api/v3/hub`,
        issue_search_url: `${ctx.baseUrl}/api/v3/search/issues?q={query}`,
        issues_url: `${ctx.baseUrl}/api/v3/issues`,
        keys_url: `${ctx.baseUrl}/api/v3/user/keys`,
        label_search_url: `${ctx.baseUrl}/api/v3/search/labels?q={query}`,
        notifications_url: `${ctx.baseUrl}/api/v3/notifications`,
        organization_repositories_url: `${ctx.baseUrl}/api/v3/orgs/{org}/repos`,
        organization_url: `${ctx.baseUrl}/api/v3/orgs/{org}`,
        public_gists_url: `${ctx.baseUrl}/api/v3/gists/public`,
        rate_limit_url: `${ctx.baseUrl}/api/v3/rate_limit`,
        repository_url: `${ctx.baseUrl}/api/v3/repos/{owner}/{repo}`,
        repository_search_url: `${ctx.baseUrl}/api/v3/search/repositories?q={query}`,
        current_user_repositories_url: `${ctx.baseUrl}/api/v3/user/repos`,
        starred_url: `${ctx.baseUrl}/api/v3/user/starred{/owner}{/repo}`,
        starred_gists_url: `${ctx.baseUrl}/api/v3/gists/starred`,
        topic_search_url: `${ctx.baseUrl}/api/v3/search/topics?q={query}`,
        user_url: `${ctx.baseUrl}/api/v3/users/{user}`,
        user_organizations_url: `${ctx.baseUrl}/api/v3/user/orgs`,
        user_repositories_url: `${ctx.baseUrl}/api/v3/users/{user}/repos`,
        user_search_url: `${ctx.baseUrl}/api/v3/search/users?q={query}`,
      },
      200,
      { 'x-oauth-scopes': 'repo, user' },
    );
  }
  if (method === 'GET' && seg.length === 1 && seg[0] === 'meta') {
    return ok({ installed_version: '1.0.0', verifiable_password_authentication: true });
  }
  if (!ctx.authed) return err(401, 'Bad credentials');

  // GET /user — the token owner's identity.
  if (method === 'GET' && seg.length === 1 && seg[0] === 'user') {
    return ok({
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: globalId('User', VIEWER.login),
      avatar_url: '',
      gravatar_id: '',
      url: `${ctx.baseUrl}/api/v3/users/${VIEWER.login}`,
      html_url: `${ctx.baseUrl}/${VIEWER.login}`,
      type: 'User',
      site_admin: false,
      name: VIEWER.name,
      company: null,
      blog: '',
      location: null,
      email: VIEWER.email,
      hireable: null,
      bio: null,
      twitter_username: null,
      public_repos: ctx.store.allRepos().length,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    });
  }

  // POST /user/repos — create a repository for the token owner.
  if (method === 'POST' && seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    const body = requireBodyObject(ctx);
    if (isRestReply(body)) return body;
    const name = str(body.name);
    if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
      return err(422, 'Repository name is invalid');
    }
    if (ctx.store.getRepo(VIEWER.login, name) !== undefined) {
      return err(422, 'Repository already exists');
    }
    const repo = ctx.store.createRepo(VIEWER.login, name, {
      description: str(body.description),
      isPrivate: body.private === true,
      defaultBranch: str(body.default_branch) || undefined,
    });
    return ok(repoJson(ctx, repo), 201);
  }

  // GET /user/repos — the token owner's repositories, paginated.
  if (method === 'GET' && seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    const repos = ctx.store.allRepos();
    const { page, headers } = paginate(ctx, '/api/v3/user/repos', repos);
    return ok(page.map((repo) => repoJson(ctx, repo)), 200, headers);
  }

  // /repos/{owner}/{name}[/...]
  if (seg.length >= 3 && seg[0] === 'repos') {
    return handleRepoRoute(ctx, seg[1]!, seg[2]!, seg.slice(3));
  }

  return err(404, 'Not Found');
}

function handleRepoRoute(ctx: RestContext, owner: string, name: string, rest: string[]): RestReply {
  const { method } = ctx;
  const found = lookupRepo(ctx, owner, name);
  if ('status' in found) return found;
  const repo = found;

  // GET /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      if (repo.isPrivate && !ctx.authed) return err(401, 'Bad credentials');
      return ok(repoJson(ctx, repo));
    }
    if (method === 'PATCH') {
      const body = requireBodyObject(ctx);
      if (isRestReply(body)) return body;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      repo.updatedAt = new Date().toISOString();
      return ok(repoJson(ctx, repo));
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(owner, name);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  const head = rest[0]!;

  // Branches
  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha: oid, url: `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/commits/${oid}` },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return ok(branches);
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = rest[1]!;
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) return err(404, 'Branch not found');
      return ok({
        name: branch,
        commit: { sha: oid, url: `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/commits/${oid}` },
        protected: false,
      });
    }
    return err(404, 'Not Found');
  }

  // Commits
  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = ctx.store.resolveRef(repo, ref);
    if (tip === null) return ok([]);
    const history = commitHistory(repo.objects, tip);
    const { page } = paginate(ctx, `/api/v3/repos/${owner}/${name}/commits`, history);
    return ok(
      page.map((sha) => {
        const obj = repo.objects.get(sha)!;
        const info = parseCommit(obj.data);
        return commitJson(ctx, repo, sha, info);
      }),
    );
  }

  // Git data: refs
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = requireBodyObject(ctx);
      if (isRestReply(body)) return body;
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/')) return err(422, 'Invalid ref name');
      if (!/^[0-9a-f]{40}$/i.test(sha) || !repo.objects.has(sha.toLowerCase())) {
        return err(422, 'Invalid sha');
      }
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha.toLowerCase());
      return ok({ ref, node_id: globalId('Ref', owner, name, ref), url: `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/git/refs/${ref}`, object: { sha: sha.toLowerCase(), type: repo.objects.get(sha.toLowerCase())!.type, url: '' } }, 201);
    }
    if (method === 'GET') {
      if (rest.length === 2) {
        const refs = [...repo.refs.entries()]
          .map(([ref, oid]) => ({ ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } }))
          .sort((a, b) => (a.ref < b.ref ? -1 : 1));
        return ok(refs);
      }
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return err(404, 'Reference not found');
      return ok({ ref, node_id: globalId('Ref', owner, name, ref), url: `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/git/refs/${ref}`, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
    }
    return err(404, 'Not Found');
  }

  // Contents
  if (head === 'contents') {
    return handleContents(ctx, repo, owner, name, rest.slice(1));
  }

  // Labels
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const body = requireBodyObject(ctx);
      if (isRestReply(body)) return body;
      const labelName = str(body.name);
      if (labelName === '') return err(422, 'Label name is required');
      if (repo.labels.has(labelName.toLowerCase())) return err(422, 'Label already exists');
      const label: Label = {
        id: ctx.store.globalId(),
        name: labelName,
        color: str(body.color) || 'ededed',
        description: str(body.description),
      };
      repo.labels.set(labelName.toLowerCase(), label);
      return ok(labelJson(ctx, repo, label), 201);
    }
    if (method === 'GET' && rest.length === 1) {
      return ok([...repo.labels.values()].map((label) => labelJson(ctx, repo, label)));
    }
    return err(404, 'Not Found');
  }

  // Issues
  if (head === 'issues') {
    return handleIssues(ctx, repo, owner, name, rest.slice(1));
  }

  // Pull requests
  if (head === 'pulls') {
    return handlePulls(ctx, repo, owner, name, rest.slice(1));
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

function handleContents(ctx: RestContext, repo: Repo, owner: string, name: string, pathParts: string[]): RestReply {
  const { method } = ctx;
  const path = pathParts.join('/');
  const refParam = ctx.query.get('ref') ?? undefined;

  const resolveBranch = (): { branch: string; tip: string | null } | RestReply => {
    const branch = refParam ?? repo.defaultBranch;
    const tip = ctx.store.resolveRef(repo, branch);
    if (tip === null && refParam !== undefined) return err(404, 'Branch not found');
    if (tip === null) return { branch, tip: null };
    return { branch, tip };
  };

  if (method === 'GET') {
    const resolved = resolveBranch();
    if ('status' in resolved) return resolved;
    const { tip } = resolved;
    if (tip === null) return err(404, 'Not Found');
    const files = ctx.store.filesAt(repo, tip);
    if (path === '') {
      return ok(directoryEntries(ctx, repo, tip, files, ''));
    }
    const file = files.get(path);
    if (file !== undefined) {
      const obj = repo.objects.get(file.oid);
      const data = obj !== undefined && obj.type === 'blob' ? obj.data : Buffer.alloc(0);
      return ok({
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop(),
        path,
        content: data.toString('base64'),
        sha: file.oid,
        url: `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/contents/${path}`,
        html_url: `${ctx.baseUrl}/${owner}/${name}/blob/${repo.defaultBranch}/${path}`,
        git_url: '',
        download_url: '',
      });
    }
    // A directory: any file below this prefix, or a subtree.
    const prefix = `${path}/`;
    const children = new Map<string, { type: 'file' | 'dir'; oid: string }>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) children.set(rest, { type: 'file', oid: entry.oid });
      else {
        const dir = rest.slice(0, slash);
        if (!children.has(dir)) {
          const dirOid = treeOidAt(ctx, repo, tip, path, dir);
          children.set(dir, { type: 'dir', oid: dirOid ?? '' });
        }
      }
    }
    if (children.size === 0) return err(404, 'Not Found');
    const entries = [...children.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([childName, child]) => ({
        type: child.type,
        size: child.type === 'file' ? (repo.objects.get(child.oid)?.data.length ?? 0) : 0,
        name: childName,
        path: `${path}/${childName}`,
        sha: child.oid,
        url: `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/contents/${path}/${childName}`,
        html_url: `${ctx.baseUrl}/${owner}/${name}/tree/${repo.defaultBranch}/${path}/${childName}`,
        git_url: '',
        download_url: '',
      }));
    return ok(entries);
  }

  if (method === 'PUT') {
    const body = requireBodyObject(ctx);
    if (isRestReply(body)) return body;
    const message = str(body.message);
    const contentB64 = str(body.content);
    if (message === '' || contentB64 === '') return err(422, 'message and content are required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    } catch {
      return err(422, 'content is not valid base64');
    }
    const branch = str(body.branch) || repo.defaultBranch;
    if (repo.refs.get(`refs/heads/${branch}`) === undefined && repo.refs.size > 0) return err(404, 'Branch not found');
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const files = tip === undefined ? new Map() : ctx.store.filesAt(repo, tip);
    const existing = files.get(path);
    const givenSha = str(body.sha);
    if (existing !== undefined) {
      if (givenSha === '' || givenSha.toLowerCase() !== existing.oid) return err(409, 'sha does not match the current file');
    } else if (givenSha !== '') {
      return err(409, 'sha does not match the current file');
    }
    const created = commitContentChange(ctx, repo, branch, path, content, message);
    if ('status' in created) return created;
    const { sha, blobSha } = created;
    return ok(
      {
        content: {
          name: path.split('/').pop(),
          path,
          sha: blobSha,
          size: content.length,
          url: `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/contents/${path}`,
          html_url: `${ctx.baseUrl}/${owner}/${name}/blob/${branch}/${path}`,
          git_url: '',
          download_url: '',
          type: 'file',
          encoding: 'base64',
          content: content.toString('base64'),
        },
        commit: { sha, message, url: `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/commits/${sha}` },
      },
      existing === undefined ? 201 : 200,
    );
  }

  if (method === 'DELETE') {
    const body = requireBodyObject(ctx);
    if (isRestReply(body)) return body;
    const message = str(body.message) || 'Delete file';
    const givenSha = str(body.sha);
    const branch = str(body.branch) || repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return err(404, 'Not Found');
    const files = ctx.store.filesAt(repo, tip);
    const existing = files.get(path);
    if (existing === undefined) return err(404, 'Not Found');
    if (givenSha !== '' && givenSha.toLowerCase() !== existing.oid) return err(409, 'sha does not match the current file');
    const created = commitContentChange(ctx, repo, branch, path, null, message);
    if ('status' in created) return created;
    const { sha } = created;
    return ok({ commit: { sha, message, url: `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/commits/${sha}` }, content: null });
  }

  return err(404, 'Not Found');
}

function directoryEntries(ctx: RestContext, repo: Repo, tip: string, files: Map<string, { oid: string; mode: string }>, dir: string): Json[] {
  const children = new Map<string, { type: 'file' | 'dir'; oid: string }>();
  const prefix = dir === '' ? '' : `${dir}/`;
  for (const [filePath, entry] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      children.set(rest, { type: 'file', oid: entry.oid });
    } else {
      const dirName = rest.slice(0, slash);
      if (!children.has(dirName)) {
        const dirOid = treeOidAt(ctx, repo, tip, dir, dirName);
        children.set(dirName, { type: 'dir', oid: dirOid ?? '' });
      }
    }
  }
  return [...children.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([childName, child]) => ({
      type: child.type,
      size: child.type === 'file' ? (repo.objects.get(child.oid)?.data.length ?? 0) : 0,
      name: childName,
      path: prefix === '' ? childName : `${prefix}${childName}`,
      sha: child.oid,
      url: '',
      html_url: '',
      git_url: '',
      download_url: '',
    }));
}

/** The tree oid of a directory inside a commit's tree, or null. */
function treeOidAt(ctx: RestContext, repo: Repo, commitOid: string, dirPath: string, childDir: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  let treeOid = parseCommit(obj.data).tree;
  const segments = dirPath === '' ? [childDir] : [...dirPath.split('/'), childDir];
  for (const segment of segments) {
    const treeObj = repo.objects.get(treeOid);
    if (treeObj === undefined || treeObj.type !== 'tree') return null;
    const entry = parseTree(treeObj.data).find((candidate) => candidate.name === segment);
    if (entry === undefined || entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function handleIssues(ctx: RestContext, repo: Repo, owner: string, name: string, rest: string[]): RestReply {
  const { method } = ctx;
  const path = `/api/v3/repos/${owner}/${name}/issues`;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = requireBodyObject(ctx);
      if (isRestReply(body)) return body;
      const title = str(body.title);
      if (title === '') return err(422, 'title is required');
      const labels: Label[] = [];
      const wanted = Array.isArray(body.labels) ? body.labels : [];
      for (const wantedLabel of wanted) {
        const label = repo.labels.get(String(wantedLabel).toLowerCase());
        if (label === undefined) return err(422, `Label '${String(wantedLabel)}' does not exist`);
        labels.push(label);
      }
      const now = new Date().toISOString();
      const issue: Issue = {
        id: ctx.store.globalId(),
        number: repo.nextNumber++,
        title,
        body: str(body.body),
        state: 'open',
        labels,
        comments: [],
        createdSeq: ctx.store.seq(),
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.set(issue.number, issue);
      return ok(issueJson(ctx, repo, issue), 201);
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const { page, headers } = paginate(ctx, path, issues);
      return ok(page.map((issue) => issueJson(ctx, repo, issue)), 200, headers);
    }
    return err(404, 'Not Found');
  }

  const number = parseInt(rest[0]!, 10);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return ok(issueJson(ctx, repo, issue));
    if (method === 'PATCH') {
      const body = requireBodyObject(ctx);
      if (isRestReply(body)) return body;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? new Date().toISOString() : null;
      }
      if (Array.isArray(body.labels)) {
        const labels: Label[] = [];
        for (const wantedLabel of body.labels) {
          const label = repo.labels.get(String(wantedLabel).toLowerCase());
          if (label === undefined) return err(422, `Label '${String(wantedLabel)}' does not exist`);
          labels.push(label);
        }
        issue.labels = labels;
      }
      issue.updatedAt = new Date().toISOString();
      return ok(issueJson(ctx, repo, issue));
    }
    return err(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const body = requireBodyObject(ctx);
      if (isRestReply(body)) return body;
      const commentBody = str(body.body);
      if (commentBody === '') return err(422, 'body is required');
      const comment = {
        id: repo.nextCommentId++,
        body: commentBody,
        user: VIEWER.login,
        createdAt: new Date().toISOString(),
      };
      issue.comments.push(comment);
      issue.updatedAt = comment.createdAt;
      return ok(commentJson(ctx, repo, issue.number, comment), 201);
    }
    if (method === 'GET') {
      const { page, headers } = paginate(ctx, `${path}/${number}/comments`, issue.comments);
      return ok(page.map((comment) => commentJson(ctx, repo, issue.number, comment)), 200, headers);
    }
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function handlePulls(ctx: RestContext, repo: Repo, owner: string, name: string, rest: string[]): RestReply {
  const { method } = ctx;
  const path = `/api/v3/repos/${owner}/${name}/pulls`;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = requireBodyObject(ctx);
      if (isRestReply(body)) return body;
      const title = str(body.title);
      const head = str(body.head);
      const base = str(body.base);
      if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return err(422, 'head or base branch not found');
      const existing = [...repo.pulls.values()].find((pull) => pull.head === head && pull.state === 'open');
      if (existing !== undefined) return err(422, 'A pull request already exists for this head branch');
      const now = new Date().toISOString();
      const pull: PullRequest = {
        id: ctx.store.globalId(),
        number: repo.nextNumber++,
        title,
        body: str(body.body),
        state: 'open',
        head,
        base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: ctx.store.seq(),
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.pulls.set(pull.number, pull);
      return ok(pullJson(ctx, repo, pull), 201);
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, headers } = paginate(ctx, path, pulls);
      return ok(page.map((pull) => pullJson(ctx, repo, pull)), 200, headers);
    }
    return err(404, 'Not Found');
  }

  const number = parseInt(rest[0]!, 10);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (pull === undefined) return err(404, 'Not Found');

  if (rest.length === 1 && method === 'GET') return ok(pullJson(ctx, repo, pull));

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const { files } = pullFiles(ctx, repo, pull);
    return ok(files);
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const body = requireBodyObject(ctx);
    if (isRestReply(body)) return body;
    const methodName = str(body.merge_method) || 'merge';
    const mergeMethod = methodName === 'squash' ? 'squash' : methodName === 'rebase' ? 'rebase' : 'merge';
    const outcome = squashMergePullRequest(ctx.store, repo, pull, mergeMethod);
    if ('error' in outcome) {
      if (outcome.error === 'pull request is already closed') return err(405, 'Pull request is already merged');
      return err(405, outcome.error);
    }
    repo.updatedAt = new Date().toISOString();
    repo.pushedAt = repo.updatedAt;
    return ok({ sha: outcome.sha, merged: true, message: `Pull request #${pull.number} merged` });
  }

  return err(404, 'Not Found');
}

/** The changed files of a pull request, diffed from its merge base to its head. */
function pullFiles(ctx: RestContext, repo: Repo, pull: PullRequest): { files: Json[] } {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`)!;
  const headTip = repo.refs.get(`refs/heads/${pull.head}`)!;
  const base = mergeBase(repo.objects, baseTip, headTip) ?? baseTip;
  const baseFiles = ctx.store.filesAt(repo, base);
  const headFiles = ctx.store.filesAt(repo, headTip);
  const changes = diffFiles(ctx.store, repo, baseFiles, headFiles);
  return {
    files: changes.map((change) => ({
      sha: change.newOid ?? change.oldOid ?? '',
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    })),
  };
}

function commitJson(ctx: RestContext, repo: Repo, sha: string, info: { tree: string; parents: string[]; author: string; committer: string; message: string }): Json {
  const parseIdent = (ident: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(ident);
    if (match === null) return { name: ident, email: '', date: new Date().toISOString() };
    return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]!) * 1000).toISOString() };
  };
  const author = parseIdent(info.author);
  const committer = parseIdent(info.committer);
  return {
    sha,
    node_id: globalId('Commit', repo.owner, repo.name, sha),
    commit: {
      author: { ...author, date: author.date },
      committer: { ...committer, date: committer.date },
      message: info.message,
      tree: { sha: info.tree },
      url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/commit/${sha}`,
    author: { login: VIEWER.login, id: VIEWER.id },
    committer: { login: VIEWER.login, id: VIEWER.id },
    parents: info.parents.map((parent) => ({ sha: parent, url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
  };
}
