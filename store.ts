// store.ts — the forge's in-memory state and the domain operations every surface
// shares (repositories, git objects and refs, issues, pull requests, labels).
// One process, no persistence: a trial starts with an empty forge.

import {
  buildCommit,
  flattenTree,
  mergeBase,
  parseCommit,
  parseTree,
  putObject,
  reachableCommits,
  reachableObjects,
  treeFromFiles,
  ZERO_OID,
  type GitObject,
  type ObjType,
} from './git.ts';

/** The token owner's identity: the sealed scenario's viewer (wire.ts SCENARIO_SEED is constant). */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** The other seeded user, who owns nothing here. */
export const STRANGER = {
  login: 'olgabauer',
  id: 1002,
  name: 'olga bauer',
  email: 'olgabauer@example.invalid',
} as const;

export function viewerIdent(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

/** The bearer token the entry accepts (MAKEFUN_SHOP_TOKEN in a trial). */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? 'dev-token';
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  dbId: number;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextDbId = 1;
  private nextGlobalId = 1;
  private nextSeq = 1;

  seq(): number {
    return this.nextSeq++;
  }

  globalId(): number {
    return this.nextGlobalId++;
  }

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, input: { description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo {
    const now = new Date().toISOString();
    const repo: Repo = {
      owner,
      name,
      description: input.description ?? '',
      isPrivate: input.isPrivate ?? false,
      defaultBranch: input.defaultBranch ?? 'main',
      dbId: this.nextDbId++,
      createdSeq: this.seq(),
      createdAt: now,
      updatedAt: now,
      pushedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Every repository, in creation order. */
  allRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /** The tip of a ref, or of a branch name, or a bare oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (/^[0-9a-f]{40}$/i.test(ref)) return repo.objects.has(ref.toLowerCase()) ? ref.toLowerCase() : null;
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      return oid ?? null;
    }
    const oid = repo.refs.get(`refs/heads/${ref}`);
    if (oid !== undefined) return oid;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    return tag ?? null;
  }

  /** Create one commit on `branch` (creating the branch when needed) from a file map. */
  commitFiles(
    repo: Repo,
    branch: string,
    files: ReadonlyMap<string, { oid: string; mode: string }>,
    message: string,
    parentOverride?: string | null,
  ): string {
    const treeOid = treeFromFiles(files, repo.objects);
    const ref = `refs/heads/${branch}`;
    const parent = parentOverride !== undefined ? parentOverride : (repo.refs.get(ref) ?? null);
    const parents = parent === null ? [] : [parent];
    const commitOid = putObject(
      repo.objects,
      'commit',
      buildCommit({ tree: treeOid, parents, author: viewerIdent(), committer: viewerIdent(), message }),
    );
    repo.refs.set(ref, commitOid);
    return commitOid;
  }

  /** The file map at a commit, as path -> {oid, mode}. */
  filesAt(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const obj = repo.objects.get(commitOid);
    if (obj === undefined || obj.type !== 'commit') return new Map();
    return flattenTree(repo.objects, parseCommit(obj.data).tree);
  }

  /** The blob bytes at a path on a commit, or null. */
  blobAt(repo: Repo, commitOid: string, path: string): Buffer | null {
    const files = this.filesAt(repo, commitOid);
    const file = files.get(path);
    if (file === undefined) return null;
    const obj = repo.objects.get(file.oid);
    return obj !== undefined && obj.type === 'blob' ? obj.data : null;
  }
}

// ---------------------------------------------------------------------------
// Shared domain operations
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  oldOid: string | null;
  newOid: string | null;
}

function countLines(data: Buffer | null): string[] {
  if (data === null) return [];
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line counts between two versions of a file (multiset difference; exact for the suite's files). */
function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = countLines(oldData);
  const newLines = countLines(newData);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

/** The file-level diff between two file maps. */
export function diffFiles(
  store: Store,
  repo: Repo,
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  head: ReadonlyMap<string, { oid: string; mode: string }>,
): FileChange[] {
  const out: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    const oldData = b === undefined ? null : (repo.objects.get(b.oid)?.data ?? null);
    const newData = h === undefined ? null : (repo.objects.get(h.oid)?.data ?? null);
    const { additions, deletions } = lineDiff(oldData, newData);
    out.push({
      path,
      status: b === undefined ? 'added' : h === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      oldOid: b?.oid ?? null,
      newOid: h?.oid ?? null,
    });
  }
  return out;
}

export interface MergeOutcome {
  ok: boolean;
  reason?: string;
  /** The merged file map (only when ok). */
  files?: Map<string, { oid: string; mode: string }>;
}

/**
 * A three-way merge of `head` onto `baseTip`, with `mergeBaseOid` as the common ancestor.
 * A file changed on both sides to different contents is a conflict.
 */
export function threeWayMerge(
  store: Store,
  repo: Repo,
  mergeBaseOid: string,
  baseTipOid: string,
  headOid: string,
): MergeOutcome {
  const baseFiles = store.filesAt(repo, mergeBaseOid);
  const tipFiles = store.filesAt(repo, baseTipOid);
  const headFiles = store.filesAt(repo, headOid);
  const merged = new Map(tipFiles);
  const paths = new Set([...baseFiles.keys(), ...tipFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path);
    const t = tipFiles.get(path);
    const h = headFiles.get(path);
    const same = (x: { oid: string } | undefined, y: { oid: string } | undefined): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
    if (same(h, b)) continue; // unchanged on the head side: keep the tip version
    if (same(t, b)) {
      // unchanged on the base side: take the head version (or its deletion)
      if (h === undefined) merged.delete(path);
      else merged.set(path, h);
      continue;
    }
    if (same(h, t)) continue; // both sides made the same change
    return { ok: false, reason: `conflict in ${path}` };
  }
  return { ok: true, files: merged };
}

/**
 * Merge a pull request with a squash commit onto its base branch.
 * Answers the merge commit oid, or null with a reason when it cannot merge.
 */
export function squashMergePullRequest(
  store: Store,
  repo: Repo,
  pr: PullRequest,
  method: 'squash' | 'merge' | 'rebase',
): { sha: string } | { error: string } {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (baseTip === undefined) return { error: 'base branch not found' };
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (headTip === undefined) return { error: 'head branch not found' };
  if (pr.merged || pr.state !== 'open') return { error: 'pull request is already closed' };
  const base = mergeBase(repo.objects, baseTip, headTip);
  if (base === null) return { error: 'no merge base' };
  const outcome = threeWayMerge(store, repo, base, baseTip, headTip);
  if (!outcome.ok) return { error: outcome.reason ?? 'merge conflict' };
  const treeOid = treeFromFiles(outcome.files!, repo.objects);
  const message = method === 'squash' ? `${pr.title} (#${pr.number})` : `Merge pull request #${pr.number} from ${pr.head}`;
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const sha = putObject(
    repo.objects,
    'commit',
    buildCommit({ tree: treeOid, parents, author: viewerIdent(), committer: viewerIdent(), message }),
  );
  repo.refs.set(`refs/heads/${pr.base}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = new Date().toISOString();
  pr.mergeCommitSha = sha;
  pr.closedAt = pr.mergedAt;
  pr.updatedAt = pr.mergedAt;
  return { sha };
}

/** Whether a pull request would merge cleanly right now (MERGEABLE vs CONFLICTING). */
export function pullRequestMergeable(store: Store, repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pr.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const base = mergeBase(repo.objects, baseTip, headTip);
  if (base === null) return 'UNKNOWN';
  return threeWayMerge(store, repo, base, baseTip, headTip).ok ? 'MERGEABLE' : 'CONFLICTING';
}

/** The objects a fetch must send: reachable(wants) minus reachable(haves), honouring depth. */
export function objectsForFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  clientShallow: readonly string[] = [],
): { oids: string[]; shallow: string[]; unshallow: string[] } {
  if (depth !== null) {
    // Walk at most `depth` generations from the wants; the boundary commits are shallow.
    // Only the included commits and their trees/blobs travel — never a parent past the boundary.
    const included = new Set<string>();
    const shallow = new Set<string>();
    const queue: { oid: string; generation: number }[] = wants.map((oid) => ({ oid, generation: 1 }));
    const seen = new Set<string>();
    while (queue.length > 0) {
      const { oid, generation } = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      included.add(oid);
      const parents = parseCommit(obj.data).parents;
      if (generation >= depth) {
        if (parents.length > 0) shallow.add(oid);
      } else {
        for (const parent of parents) queue.push({ oid: parent, generation: generation + 1 });
      }
    }
    // A boundary the client already had stops being shallow once this fetch includes
    // the commit and every one of its parents.
    const unshallow: string[] = [];
    for (const boundary of clientShallow) {
      if (!included.has(boundary)) continue;
      const obj = repo.objects.get(boundary);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.every((parent) => included.has(parent))) unshallow.push(boundary);
    }
    const oids = new Set<string>();
    for (const commit of included) {
      oids.add(commit);
      const obj = repo.objects.get(commit);
      if (obj === undefined || obj.type !== 'commit') continue;
      const tree = parseCommit(obj.data).tree;
      // The commit's tree and blobs only — never a parent past the boundary.
      const addTree = (treeOid: string): void => {
        const treeObj = repo.objects.get(treeOid);
        if (treeObj === undefined || treeObj.type !== 'tree') return;
        oids.add(treeOid);
        for (const entry of parseTree(treeObj.data)) {
          if (entry.mode === '40000') addTree(entry.oid);
          else oids.add(entry.oid);
        }
      };
      addTree(tree);
    }
    return { oids: [...oids], shallow: [...shallow], unshallow };
  }
  const wantSet = reachableObjects(repo.objects, wants);
  const haveSet = reachableObjects(repo.objects, haves);
  const oids = [...wantSet].filter((oid) => !haveSet.has(oid));
  return { oids, shallow: [], unshallow: [] };
}

/** The first have that is an ancestor-or-equal of a want (for the fetch ACK), or null. */
export function ackForFetch(repo: Repo, wants: readonly string[], haves: readonly string[]): string | null {
  const wantAncestors = new Set<string>();
  for (const want of wants) {
    for (const commit of reachableCommits(repo.objects, [want])) wantAncestors.add(commit);
  }
  for (const have of haves) {
    if (wantAncestors.has(have)) return have;
  }
  return null;
}

export { ZERO_OID };
export type { GitObject, ObjType };
