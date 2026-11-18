// graphql.ts — a small GraphQL v4 executor for the documents gh and github-mcp-server send.
// No GraphQL library: a hand-written parser and resolver over the same store the REST
// surface uses, so a mutation here is visible there and back. Supports variables, inline
// enums and input objects, inline fragments, aliases, operation batching and __type.

import { diffFiles, pullRequestMergeable, squashMergePullRequest, VIEWER, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { mergeBase } from './git.ts';
import { globalId } from './rest.ts';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; type: string }[];
  selections: SelectionNode[];
}

interface FragmentDefNode {
  kind: 'fragmentDef';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

class ParseError extends Error {}

class Lexer {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos]!)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  peek(): string {
    const saved = this.pos;
    const token = this.next();
    this.pos = saved;
    return token;
  }

  next(): string {
    this.skipIgnored();
    if (this.text.slice(this.pos, this.pos + 3) === '...') {
      this.pos += 3;
      return '...';
    }
    const ch = this.text[this.pos] ?? '';
    if (ch === '') return '';
    if (/[!$():=\[\]{}@&|]/.test(ch)) {
      this.pos += 1;
      return ch;
    }
    if (ch === '"') {
      let out = '';
      this.pos += 1;
      while (this.pos < this.text.length && this.text[this.pos] !== '"') {
        const c = this.text[this.pos]!;
        if (c === '\\' && this.pos + 1 < this.text.length) {
          const esc = this.text[this.pos + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          this.pos += 2;
        } else {
          out += c;
          this.pos += 1;
        }
      }
      this.pos += 1;
      return JSON.stringify(out);
    }
    const match = /^-?(?:[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)|[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (match === null) throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
    this.pos += match[0].length;
    return match[0];
  }

  /** Read a raw name/number token (used after a string was already consumed as JSON). */
  readName(): string {
    const token = this.next();
    if (token.startsWith('"')) return JSON.parse(token) as string;
    return token;
  }
}

class Parser {
  private readonly lexer: Lexer;
  constructor(text: string) {
    this.lexer = new Lexer(text);
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentDefNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDefNode>();
    while (this.lexer.peek() !== '') {
      const token = this.lexer.peek();
      if (token === 'query' || token === 'mutation') {
        operations.push(this.parseOperation());
      } else if (token === 'fragment') {
        const def = this.parseFragmentDef();
        fragments.set(def.name, def);
      } else if (token === '{') {
        operations.push({ kind: 'operation', operation: 'query', name: null, variables: [], selections: this.parseSelectionSet() });
      } else {
        throw new ParseError(`unexpected token ${JSON.stringify(token)}`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    const operation = this.lexer.next() as 'query' | 'mutation';
    let name: string | null = null;
    const next = this.lexer.peek();
    if (next !== '' && next !== '(' && next !== '{' && next !== '@') name = this.lexer.readName();
    const variables: { name: string; type: string }[] = [];
    if (this.lexer.peek() === '(') {
      this.lexer.next();
      while (this.lexer.peek() !== ')') {
        const dollar = this.lexer.next();
        if (dollar !== '$') throw new ParseError('expected $ in variable definition');
        const varName = this.lexer.readName();
        if (this.lexer.next() !== ':') throw new ParseError('expected : in variable definition');
        const type = this.parseType();
        if (this.lexer.peek() === '=') {
          this.lexer.next();
          this.parseValue();
        }
        variables.push({ name: varName, type });
      }
      this.lexer.next();
    }
    while (this.lexer.peek() === '@') {
      this.lexer.next();
      this.lexer.readName();
      if (this.lexer.peek() === '(') this.parseArguments();
    }
    return { kind: 'operation', operation, name, variables, selections: this.parseSelectionSet() };
  }

  private parseType(): string {
    let type: string;
    if (this.lexer.peek() === '[') {
      this.lexer.next();
      type = `[${this.parseType()}]`;
      if (this.lexer.next() !== ']') throw new ParseError('expected ] in type');
    } else {
      type = this.lexer.readName();
    }
    if (this.lexer.peek() === '!') {
      this.lexer.next();
      type += '!';
    }
    return type;
  }

  private parseFragmentDef(): FragmentDefNode {
    this.lexer.next(); // fragment
    const name = this.lexer.readName();
    if (this.lexer.next() !== 'on') throw new ParseError('expected on in fragment definition');
    const typeCondition = this.lexer.readName();
    while (this.lexer.peek() === '@') {
      this.lexer.next();
      this.lexer.readName();
      if (this.lexer.peek() === '(') this.parseArguments();
    }
    return { kind: 'fragmentDef', name, typeCondition, selections: this.parseSelectionSet() };
  }

  private parseSelectionSet(): SelectionNode[] {
    if (this.lexer.next() !== '{') throw new ParseError('expected {');
    const selections: SelectionNode[] = [];
    while (this.lexer.peek() !== '}') {
      if (this.lexer.peek() === '') throw new ParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.lexer.next();
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.lexer.peek() === '...') {
      this.lexer.next();
      const next = this.lexer.peek();
      if (next === 'on') {
        this.lexer.next();
        const typeCondition = this.lexer.readName();
        while (this.lexer.peek() === '@') {
          this.lexer.next();
          this.lexer.readName();
          if (this.lexer.peek() === '(') this.parseArguments();
        }
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next === '{') {
        return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
      }
      // A named fragment spread: inline its definition at execution time.
      const name = this.lexer.readName();
      return { kind: 'fragment', typeCondition: `...${name}`, selections: [] };
    }
    const first = this.lexer.readName();
    let alias: string | null = null;
    let name = first;
    if (this.lexer.peek() === ':') {
      this.lexer.next();
      alias = first;
      name = this.lexer.readName();
    }
    const args = this.lexer.peek() === '(' ? this.parseArguments() : [];
    while (this.lexer.peek() === '@') {
      this.lexer.next();
      this.lexer.readName();
      if (this.lexer.peek() === '(') this.parseArguments();
    }
    const selections = this.lexer.peek() === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.lexer.next(); // (
    const args: { name: string; value: ValueNode }[] = [];
    while (this.lexer.peek() !== ')') {
      const name = this.lexer.readName();
      if (this.lexer.next() !== ':') throw new ParseError('expected : in argument');
      args.push({ name, value: this.parseValue() });
    }
    this.lexer.next();
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.lexer.peek();
    if (token === '$') {
      this.lexer.next();
      return { kind: 'variable', name: this.lexer.readName() };
    }
    if (token === '[') {
      this.lexer.next();
      const values: ValueNode[] = [];
      while (this.lexer.peek() !== ']') values.push(this.parseValue());
      this.lexer.next();
      return { kind: 'list', values };
    }
    if (token === '{') {
      this.lexer.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (this.lexer.peek() !== '}') {
        const name = this.lexer.readName();
        if (this.lexer.next() !== ':') throw new ParseError('expected : in input object');
        fields.push({ name, value: this.parseValue() });
      }
      this.lexer.next();
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) {
      this.lexer.next();
      return { kind: 'string', value: JSON.parse(token) as string };
    }
    const raw = this.lexer.next();
    if (/^-?[0-9]+$/.test(raw)) return { kind: 'int', value: parseInt(raw, 10) };
    if (/^-?[0-9]*\.[0-9]+(?:[eE][+-]?[0-9]+)?$/.test(raw) || /^-?[0-9]+[eE][+-]?[0-9]+$/.test(raw)) {
      return { kind: 'float', value: parseFloat(raw) };
    }
    if (raw === 'true') return { kind: 'boolean', value: true };
    if (raw === 'false') return { kind: 'boolean', value: false };
    if (raw === 'null') return { kind: 'null' };
    return { kind: 'enum', value: raw };
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue };

/** What a field resolver can return: a scalar, an object node, or a list of either. */
type ResolvedValue = NodeValue | GqlValue | ResolvedValue[] | null;

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema (for validation and __type)
// ---------------------------------------------------------------------------

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email', 'url'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'private', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'createdAt', 'updatedAt', 'url', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'url', 'repository'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'files', 'commits', 'url', 'repository'],
  },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changes', 'status', 'filename'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  GitRef: { kind: 'OBJECT', fields: ['name', 'prefix', 'target'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  CommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'args', 'type'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description'] },
  __InputValue: { kind: 'OBJECT', fields: ['name', 'description', 'type', 'defaultValue'] },
  __Schema: { kind: 'OBJECT', fields: ['types', 'queryType', 'mutationType', 'description'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', enumValues: ['COMMIT', 'DISCUSSION', 'ISSUE', 'MILESTONE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'WIKI'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  CreateIssueInput: { kind: 'INPUT_OBJECT', fields: ['repositoryId', 'title', 'body', 'clientMutationId'] },
  CloseIssueInput: { kind: 'INPUT_OBJECT', fields: ['issueId', 'clientMutationId'] },
  CreatePullRequestInput: { kind: 'INPUT_OBJECT', fields: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body', 'clientMutationId'] },
  MergePullRequestInput: { kind: 'INPUT_OBJECT', fields: ['pullRequestId', 'mergeMethod', 'clientMutationId'] },
  AddCommentInput: { kind: 'INPUT_OBJECT', fields: ['subjectId', 'body', 'clientMutationId'] },
};

// The return type of each root and nested field the executor resolves.
const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  Repository: { owner: 'User', defaultBranchRef: 'GitRef', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
  Issue: { author: 'User', labels: 'Label', comments: 'IssueCommentConnection', repository: 'Repository' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
  IssueEdge: { node: 'Issue' },
  PullRequest: { author: 'User', headRef: 'GitRef', baseRef: 'GitRef', mergeCommit: 'Commit', files: 'PullRequestChangedFileConnection', repository: 'Repository' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'PullRequestChangedFileEdge', pageInfo: 'PageInfo' },
  IssueCommentConnection: { nodes: 'IssueComment', edges: 'CommentEdge', pageInfo: 'PageInfo' },
  CommentEdge: { node: 'IssueComment' },
  AddCommentPayload: { commentEdge: 'CommentEdge' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  __Type: { fields: '__Field', enumValues: '__EnumValue', inputFields: '__InputValue', interfaces: '__Type', possibleTypes: '__Type' },
  __Schema: { types: '__Type', queryType: '__Type', mutationType: '__Type' },
};

// ---------------------------------------------------------------------------
// Internal node values
// ---------------------------------------------------------------------------

type NodeValue =
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { __typename: 'IssueConnection'; repo: Repo; items: Issue[]; pageInfo: PageInfoValue }
  | { __typename: 'PullRequestConnection'; repo: Repo; items: PullRequest[]; pageInfo: PageInfoValue }
  | { __typename: 'PullRequestChangedFileConnection'; files: FileChange[]; pageInfo: PageInfoValue }
  | { __typename: 'IssueCommentConnection'; repo: Repo; issueNumber: number; items: { id: number; body: string; createdAt: string }[]; pageInfo: PageInfoValue }
  | { __typename: 'PullRequestChangedFile'; file: FileChange }
  | { __typename: 'PageInfo'; value: PageInfoValue }
  | { __typename: 'GitRef'; name: string }
  | { __typename: 'Label'; repo: Repo; label: { name: string; color: string; description: string } }
  | { __typename: 'IssueComment'; repo: Repo; issueNumber: number; comment: { id: number; body: string; createdAt: string } }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: '__InputValue'; name: string }
  | { __typename: 'IssueEdge'; node: NodeValue; cursor: string }
  | { __typename: 'CommentEdge'; node: NodeValue; cursor: string }
  | { __typename: 'CreateIssuePayload'; issue: NodeValue | null }
  | { __typename: 'CloseIssuePayload'; issue: NodeValue | null }
  | { __typename: 'CreatePullRequestPayload'; pull: NodeValue | null }
  | { __typename: 'MergePullRequestPayload'; pull: NodeValue | null }
  | { __typename: 'AddCommentPayload'; comment: NodeValue | null };

interface FileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

interface PageInfoValue {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: string | null): number {
  if (cursor === null || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : parseInt(match[1]!, 10);
  } catch {
    return -1;
  }
}

/** Slice a list by first/after and build its pageInfo. */
function page<T>(items: readonly T[], first: number | null, after: string | null): { slice: T[]; pageInfo: PageInfoValue } {
  const start = indexOfCursor(after) + 1;
  const limit = first === null ? items.length : Math.max(0, first);
  const slice = items.slice(start, start + limit);
  const endIndex = start + slice.length - 1;
  return {
    slice,
    pageInfo: {
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorFor(start) : null,
      endCursor: slice.length > 0 ? cursorFor(endIndex) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  baseUrl: string;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefNode>;
  errors: { message: string }[];
}

function argValue(field: FieldNode, name: string, ctx: ExecContext): unknown {
  const arg = field.args.find((candidate) => candidate.name === name);
  if (arg === undefined) return undefined;
  return evalValue(arg.value, ctx.variables);
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveGlobalId(store: Store, id: string): { kind: string; repo: Repo; number?: number; commentId?: number } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^(Repository|Issue|PullRequest|IssueComment):(.+)$/.exec(text);
  if (match === null) return null;
  const kind = match[1]!;
  const rest = match[2]!;
  const parts = rest.split('/');
  if (kind === 'Repository' && parts.length === 2) {
    const repo = store.getRepo(parts[0]!, parts[1]!);
    return repo === undefined ? null : { kind, repo };
  }
  if ((kind === 'Issue' || kind === 'PullRequest') && parts.length === 3) {
    const repo = store.getRepo(parts[0]!, parts[1]!);
    if (repo === undefined) return null;
    return { kind, repo, number: parseInt(parts[2]!, 10) };
  }
  if (kind === 'IssueComment' && parts.length === 4) {
    const repo = store.getRepo(parts[0]!, parts[1]!);
    if (repo === undefined) return null;
    return { kind, repo, number: parseInt(parts[2]!, 10), commentId: parseInt(parts[3]!, 10) };
  }
  return null;
}

function sortedIssues(repo: Repo, states: string[] | null, orderBy: { field: string; direction: string } | null): Issue[] {
  let issues = [...repo.issues.values()];
  if (states !== null && states.length > 0) {
    const wanted = new Set(states);
    issues = issues.filter((issue) => wanted.has(issueState(issue)));
  }
  const field = orderBy?.field ?? 'CREATED_AT';
  const direction = orderBy?.direction ?? 'DESC';
  const sign = direction === 'ASC' ? 1 : -1;
  issues.sort((a, b) => {
    if (field === 'COMMENTS') return sign * (a.comments.length - b.comments.length) || sign * (a.createdSeq - b.createdSeq);
    if (field === 'UPDATED_AT') return sign * (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.createdSeq - b.createdSeq);
    return sign * (a.createdSeq - b.createdSeq);
  });
  return issues;
}

function resolveField(parentType: string, parent: NodeValue | null, field: FieldNode, ctx: ExecContext): ResolvedValue {
  const store = ctx.store;
  const name = field.name;

  // Introspection entry points.
  if (name === '__type' && parentType === 'Query') {
    const typeName = argValue(field, 'name', ctx);
    if (typeof typeName !== 'string' || SCHEMA[typeName] === undefined) return null;
    return { __typename: '__Type', name: typeName };
  }
  if (name === '__schema' && parentType === 'Query') {
    return { __typename: '__Type', name: '__Schema' };
  }

  if (parent === null) return null;

  switch (parent.__typename) {
    case 'User': {
      if (name === 'login') return parent.login;
      if (name === 'name') return parent.login === VIEWER.login ? VIEWER.name : parent.login;
      if (name === 'email') return parent.login === VIEWER.login ? VIEWER.email : `${parent.login}@example.invalid`;
      if (name === 'id') return parent.login === VIEWER.login ? VIEWER.id : 0;
      if (name === 'url') return `${ctx.baseUrl}/${parent.login}`;
      return null;
    }
    case 'Repository': {
      const repo = parent.repo;
      switch (name) {
        case 'id': return globalId('Repository', repo.owner, repo.name);
        case 'databaseId': return repo.dbId;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { __typename: 'User', login: repo.owner };
        case 'description': return repo.description;
        case 'private': case 'isPrivate': return repo.isPrivate;
        case 'defaultBranchRef': return { __typename: 'GitRef', name: repo.defaultBranch };
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'url': return `${ctx.baseUrl}/${repo.owner}/${repo.name}`;
        case 'issue': {
          const number = argValue(field, 'number', ctx);
          if (typeof number !== 'number') return null;
          const issue = repo.issues.get(number);
          return issue === undefined ? null : { __typename: 'Issue', repo, issue };
        }
        case 'issues': {
          const first = argValue(field, 'first', ctx);
          const after = argValue(field, 'after', ctx);
          const states = argValue(field, 'states', ctx);
          const orderBy = argValue(field, 'orderBy', ctx);
          const ordered = sortedIssues(
            repo,
            Array.isArray(states) ? (states as string[]) : null,
            orderBy !== null && typeof orderBy === 'object' ? (orderBy as { field: string; direction: string }) : null,
          );
          const { slice, pageInfo } = page(ordered, typeof first === 'number' ? first : null, typeof after === 'string' ? after : null);
          return { __typename: 'IssueConnection', repo, items: slice, pageInfo };
        }
        case 'pullRequest': {
          const number = argValue(field, 'number', ctx);
          if (typeof number !== 'number') return null;
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
        }
        case 'pullRequests': {
          const first = argValue(field, 'first', ctx);
          const after = argValue(field, 'after', ctx);
          const states = argValue(field, 'states', ctx);
          let pulls = [...repo.pulls.values()];
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states as string[]);
            pulls = pulls.filter((pull) => wanted.has(pullState(pull)));
          } else {
            pulls = pulls.filter((pull) => pull.state === 'open');
          }
          pulls.sort((a, b) => b.createdSeq - a.createdSeq);
          const { slice, pageInfo } = page(pulls, typeof first === 'number' ? first : null, typeof after === 'string' ? after : null);
          return { __typename: 'PullRequestConnection', repo, items: slice, pageInfo };
        }
        default: return null;
      }
    }
    case 'Issue': {
      const issue = parent.issue;
      switch (name) {
        case 'id': return globalId('Issue', parent.repo.owner, parent.repo.name, issue.number);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issueState(issue);
        case 'author': return { __typename: 'User', login: VIEWER.login };
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'closedAt': return issue.closedAt;
        case 'url': return `${ctx.baseUrl}/${parent.repo.owner}/${parent.repo.name}/issues/${issue.number}`;
        case 'labels': return issue.labels.map((label) => ({ __typename: 'Label', repo: parent.repo, label }));
        case 'comments': {
          const first = argValue(field, 'first', ctx);
          const after = argValue(field, 'after', ctx);
          const { slice, pageInfo } = page(issue.comments, typeof first === 'number' ? first : null, typeof after === 'string' ? after : null);
          return { __typename: 'IssueCommentConnection', repo: parent.repo, issueNumber: issue.number, items: slice, pageInfo };
        }
        case 'repository': return { __typename: 'Repository', repo: parent.repo };
        default: return null;
      }
    }
    case 'PullRequest': {
      const pull = parent.pull;
      const repo = parent.repo;
      switch (name) {
        case 'id': return globalId('PullRequest', repo.owner, repo.name, pull.number);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullState(pull);
        case 'merged': return pull.merged;
        case 'mergeable': return pullRequestMergeable(store, repo, pull);
        case 'headRefName': return pull.head;
        case 'baseRefName': return pull.base;
        case 'headRef': return { __typename: 'GitRef', name: pull.head };
        case 'baseRef': return { __typename: 'GitRef', name: pull.base };
        case 'author': return { __typename: 'User', login: VIEWER.login };
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'closedAt': return pull.closedAt;
        case 'mergedAt': return pull.mergedAt;
        case 'mergeCommit': return null;
        case 'url': return `${ctx.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'repository': return { __typename: 'Repository', repo };
        case 'files': {
          const first = argValue(field, 'first', ctx);
          const after = argValue(field, 'after', ctx);
          const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
          const headTip = repo.refs.get(`refs/heads/${pull.head}`);
          if (baseTip === undefined || headTip === undefined) {
            return { __typename: 'PullRequestChangedFileConnection', files: [], pageInfo: page([], null, null).pageInfo };
          }
          const base = mergeBase(repo.objects, baseTip, headTip) ?? baseTip;
          const changes = diffFiles(store, repo, store.filesAt(repo, base), store.filesAt(repo, headTip));
          const files: FileChange[] = changes.map((change) => ({
            path: change.path,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.changes,
          }));
          const { slice, pageInfo } = page(files, typeof first === 'number' ? first : null, typeof after === 'string' ? after : null);
          return { __typename: 'PullRequestChangedFileConnection', files: slice, pageInfo };
        }
        default: return null;
      }
    }
    case 'IssueConnection': {
      if (name === 'nodes') return parent.items.map((issue) => ({ __typename: 'Issue', repo: parent.repo, issue }));
      if (name === 'edges') return parent.items.map((issue, index) => ({ __typename: 'IssueEdge', node: { __typename: 'Issue', repo: parent.repo, issue }, cursor: cursorFor(index) }));
      if (name === 'pageInfo') return { __typename: 'PageInfo', value: parent.pageInfo };
      if (name === 'totalCount') return parent.items.length;
      return null;
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') return parent.items.map((pull) => ({ __typename: 'PullRequest', repo: parent.repo, pull }));
      if (name === 'edges') return parent.items.map((pull, index) => ({ __typename: 'IssueEdge', node: { __typename: 'PullRequest', repo: parent.repo, pull }, cursor: cursorFor(index) }));
      if (name === 'pageInfo') return { __typename: 'PageInfo', value: parent.pageInfo };
      if (name === 'totalCount') return parent.items.length;
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      if (name === 'nodes') return parent.files.map((file) => ({ __typename: 'PullRequestChangedFile', file }));
      if (name === 'pageInfo') return { __typename: 'PageInfo', value: parent.pageInfo };
      if (name === 'totalCount') return parent.files.length;
      return null;
    }
    case 'IssueCommentConnection': {
      if (name === 'nodes') return parent.items.map((comment) => ({ __typename: 'IssueComment', repo: parent.repo, issueNumber: parent.issueNumber, comment }));
      if (name === 'edges') return parent.items.map((comment, index) => ({ __typename: 'CommentEdge', node: { __typename: 'IssueComment', repo: parent.repo, issueNumber: parent.issueNumber, comment }, cursor: cursorFor(index) }));
      if (name === 'pageInfo') return { __typename: 'PageInfo', value: parent.pageInfo };
      if (name === 'totalCount') return parent.items.length;
      return null;
    }
    case 'PullRequestChangedFile': {
      const file = parent.file;
      switch (name) {
        case 'path': case 'filename': return file.path;
        case 'status': return file.status.toUpperCase();
        case 'additions': return file.additions;
        case 'deletions': return file.deletions;
        case 'changes': return file.changes;
        default: return null;
      }
    }
    case 'PageInfo': {
      const value = parent.value;
      switch (name) {
        case 'hasNextPage': return value.hasNextPage;
        case 'hasPreviousPage': return value.hasPreviousPage;
        case 'startCursor': return value.startCursor;
        case 'endCursor': return value.endCursor;
        default: return null;
      }
    }
    case 'GitRef': {
      if (name === 'name') return parent.name;
      if (name === 'prefix') return 'refs/heads/';
      if (name === 'target') return null;
      return null;
    }
    case 'Label': {
      if (name === 'id') return globalId('Label', parent.repo.owner, parent.repo.name, parent.label.name);
      if (name === 'name') return parent.label.name;
      if (name === 'color') return parent.label.color;
      if (name === 'description') return parent.label.description;
      return null;
    }
    case 'IssueComment': {
      const comment = parent.comment;
      switch (name) {
        case 'id': return globalId('IssueComment', parent.repo.owner, parent.repo.name, parent.issueNumber, comment.id);
        case 'databaseId': return comment.id;
        case 'body': return comment.body;
        case 'author': return { __typename: 'User', login: VIEWER.login };
        case 'createdAt': return comment.createdAt;
        case 'updatedAt': return comment.createdAt;
        default: return null;
      }
    }
    case 'IssueEdge': case 'CommentEdge': {
      if (name === 'node') return parent.node;
      if (name === 'cursor') return parent.cursor;
      return null;
    }
    case '__Type': {
      const def = SCHEMA[parent.name];
      switch (name) {
        case 'name': return parent.name;
        case 'kind': return def?.kind ?? 'OBJECT';
        case 'description': return null;
        case 'fields': {
          const includeDeprecated = argValue(field, 'includeDeprecated', ctx);
          void includeDeprecated;
          return (def?.fields ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName }));
        }
        case 'enumValues': {
          return (def?.enumValues ?? []).map((value) => ({ __typename: '__EnumValue', name: value }));
        }
        case 'inputFields': return [];
        case 'interfaces': return [];
        case 'possibleTypes': return [];
        default: return null;
      }
    }
    case '__Field': {
      if (name === 'name') return parent.name;
      if (name === 'description') return null;
      if (name === 'args') return [];
      if (name === 'type') return { __typename: '__Type', name: 'String' };
      return null;
    }
    case '__EnumValue': {
      if (name === 'name') return parent.name;
      if (name === 'description') return null;
      return null;
    }
    case '__InputValue': {
      if (name === 'name') return parent.name;
      if (name === 'description') return null;
      if (name === 'type') return { __typename: '__Type', name: 'String' };
      if (name === 'defaultValue') return null;
      return null;
    }
    case 'CreateIssuePayload': case 'CloseIssuePayload': {
      if (name === 'issue') return parent.issue;
      if (name === 'clientMutationId') return null;
      return null;
    }
    case 'CreatePullRequestPayload': case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return parent.pull;
      if (name === 'clientMutationId') return null;
      return null;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') {
        if (parent.comment === null) return null;
        return { __typename: 'CommentEdge', node: parent.comment, cursor: cursorFor(0) };
      }
      if (name === 'clientMutationId') return null;
      return null;
    }
    default:
      return null;
  }
}

/** The type a value resolves to (for fragment matching and field lookup). */
function typeOf(value: NodeValue | null): string | null {
  if (value === null || typeof value !== 'object') return null;
  return (value as NodeValue).__typename;
}

/** Validate every selected field against the schema; collect unknown-field errors. */
function validateSelections(
  selections: SelectionNode[],
  parentType: string,
  ctx: ExecContext,
  fragments: Map<string, FragmentDefNode>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition.startsWith('...')) {
        const def = fragments.get(selection.typeCondition.slice(3));
        if (def !== undefined) validateSelections(def.selections, def.typeCondition, ctx, fragments);
        continue;
      }
      const type = selection.typeCondition ?? parentType;
      validateSelections(selection.selections, type, ctx, fragments);
      continue;
    }
    const fieldDef = SCHEMA[parentType];
    if (fieldDef?.kind === 'OBJECT' && !(fieldDef.fields ?? []).includes(selection.name) && !selection.name.startsWith('__')) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
      continue;
    }
    // __typename is always valid.
    if (selection.name === '__typename') continue;
    const childType = FIELD_TYPES[parentType]?.[selection.name];
    if (childType !== undefined && selection.selections.length > 0) {
      validateSelections(selection.selections, childType, ctx, fragments);
    }
  }
}

function executeSelections(
  selections: SelectionNode[],
  parentType: string,
  parent: NodeValue | null,
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition.startsWith('...')) {
        const def = ctx.fragments.get(selection.typeCondition.slice(3));
        if (def === undefined) continue;
        if (typeOf(parent) !== def.typeCondition) continue;
        Object.assign(out, executeSelections(def.selections, def.typeCondition, parent, ctx));
        continue;
      }
      const type = selection.typeCondition ?? parentType;
      if (typeOf(parent) !== null && typeOf(parent) !== type) continue;
      Object.assign(out, executeSelections(selection.selections, type, parent, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = parentType;
      continue;
    }
    const value = resolveField(parentType, parent, selection, ctx);
    out[key] = executeValue(value, selection, parentType, ctx);
  }
  return out;
}

function executeValue(
  value: ResolvedValue,
  field: FieldNode,
  parentType: string,
  ctx: ExecContext,
): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    const childType = FIELD_TYPES[parentType]?.[field.name];
    return value.map((item) => {
      if (item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
        return executeSelections(field.selections, (item as NodeValue).__typename, item as NodeValue, ctx);
      }
      void childType;
      return item as unknown;
    });
  }
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    const node = value as NodeValue;
    if (field.selections.length === 0) return null;
    return executeSelections(field.selections, node.__typename, node, ctx);
  }
  return value as unknown;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function resolveRootField(field: FieldNode, ctx: ExecContext): NodeValue | GqlValue | null {
  const store = ctx.store;
  if (field.name === 'viewer') return { __typename: 'User', login: VIEWER.login };
  if (field.name === 'repository') {
    const owner = argValue(field, 'owner', ctx);
    const name = argValue(field, 'name', ctx);
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    const repo = store.getRepo(owner, name);
    return repo === undefined ? null : { __typename: 'Repository', repo };
  }
  if (field.name === 'node') {
    const id = argValue(field, 'id', ctx);
    if (typeof id !== 'string') return null;
    const resolved = resolveGlobalId(store, id);
    if (resolved === null) return null;
    if (resolved.kind === 'Repository') return { __typename: 'Repository', repo: resolved.repo };
    if (resolved.kind === 'Issue') {
      const issue = resolved.repo.issues.get(resolved.number!);
      return issue === undefined ? null : { __typename: 'Issue', repo: resolved.repo, issue };
    }
    if (resolved.kind === 'PullRequest') {
      const pull = resolved.repo.pulls.get(resolved.number!);
      return pull === undefined ? null : { __typename: 'PullRequest', repo: resolved.repo, pull };
    }
    if (resolved.kind === 'IssueComment') {
      const issue = resolved.repo.issues.get(resolved.number!);
      const comment = issue?.comments.find((candidate) => candidate.id === resolved.commentId);
      return comment === undefined ? null : { __typename: 'IssueComment', repo: resolved.repo, issueNumber: resolved.number!, comment };
    }
    return null;
  }
  return null;
}

function executeMutation(field: FieldNode, ctx: ExecContext): NodeValue | null {
  const store = ctx.store;
  const input = argValue(field, 'input', ctx);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    ctx.errors.push({ message: `Mutation ${field.name} needs an input object.` });
    return null;
  }
  const args = input as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repoId = args.repositoryId;
      if (typeof repoId !== 'string') return null;
      const resolved = resolveGlobalId(store, repoId);
      if (resolved === null || resolved.kind !== 'Repository') {
        ctx.errors.push({ message: 'createIssue: repository not found.' });
        return null;
      }
      const title = args.title;
      if (typeof title !== 'string' || title === '') {
        ctx.errors.push({ message: 'createIssue: title is required.' });
        return null;
      }
      const now = new Date().toISOString();
      const issue: Issue = {
        id: store.globalId(),
        number: resolved.repo.nextNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: store.seq(),
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      resolved.repo.issues.set(issue.number, issue);
      return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo: resolved.repo, issue } };
    }
    case 'closeIssue': {
      const issueId = args.issueId;
      if (typeof issueId !== 'string') return null;
      const resolved = resolveGlobalId(store, issueId);
      if (resolved === null || resolved.kind !== 'Issue') {
        ctx.errors.push({ message: 'closeIssue: issue not found.' });
        return null;
      }
      const issue = resolved.repo.issues.get(resolved.number!);
      if (issue === undefined) {
        ctx.errors.push({ message: 'closeIssue: issue not found.' });
        return null;
      }
      issue.state = 'closed';
      issue.closedAt = new Date().toISOString();
      issue.updatedAt = issue.closedAt;
      return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo: resolved.repo, issue } };
    }
    case 'createPullRequest': {
      const repoId = args.repositoryId;
      if (typeof repoId !== 'string') return null;
      const resolved = resolveGlobalId(store, repoId);
      if (resolved === null || resolved.kind !== 'Repository') {
        ctx.errors.push({ message: 'createPullRequest: repository not found.' });
        return null;
      }
      const repo = resolved.repo;
      const head = args.headRefName;
      const base = args.baseRefName;
      const title = args.title;
      if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') {
        ctx.errors.push({ message: 'createPullRequest: headRefName, baseRefName and title are required.' });
        return null;
      }
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        ctx.errors.push({ message: 'createPullRequest: head or base branch not found.' });
        return null;
      }
      const now = new Date().toISOString();
      const pull: PullRequest = {
        id: store.globalId(),
        number: repo.nextNumber++,
        title,
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
      return { __typename: 'CreatePullRequestPayload', pull: { __typename: 'PullRequest', repo, pull } };
    }
    case 'mergePullRequest': {
      const pullId = args.pullRequestId;
      if (typeof pullId !== 'string') return null;
      const resolved = resolveGlobalId(store, pullId);
      if (resolved === null || resolved.kind !== 'PullRequest') {
        ctx.errors.push({ message: 'mergePullRequest: pull request not found.' });
        return null;
      }
      const pull = resolved.repo.pulls.get(resolved.number!);
      if (pull === undefined) {
        ctx.errors.push({ message: 'mergePullRequest: pull request not found.' });
        return null;
      }
      const method = args.mergeMethod === 'MERGE' ? 'merge' : args.mergeMethod === 'REBASE' ? 'rebase' : 'squash';
      const outcome = squashMergePullRequest(store, resolved.repo, pull, method);
      if ('error' in outcome) {
        ctx.errors.push({ message: `mergePullRequest: ${outcome.error}` });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', pull: { __typename: 'PullRequest', repo: resolved.repo, pull } };
    }
    case 'addComment': {
      const subjectId = args.subjectId;
      const body = args.body;
      if (typeof subjectId !== 'string' || typeof body !== 'string') {
        ctx.errors.push({ message: 'addComment: subjectId and body are required.' });
        return null;
      }
      const resolved = resolveGlobalId(store, subjectId);
      if (resolved === null || resolved.kind !== 'Issue') {
        ctx.errors.push({ message: 'addComment: subject not found.' });
        return null;
      }
      const issue = resolved.repo.issues.get(resolved.number!);
      if (issue === undefined) {
        ctx.errors.push({ message: 'addComment: subject not found.' });
        return null;
      }
      const comment = { id: resolved.repo.nextCommentId++, body, user: VIEWER.login, createdAt: new Date().toISOString() };
      issue.comments.push(comment);
      issue.updatedAt = comment.createdAt;
      return {
        __typename: 'AddCommentPayload',
        comment: { __typename: 'IssueComment', repo: resolved.repo, issueNumber: issue.number, comment },
      };
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
      return null;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface GraphQLReply {
  status: number;
  body: unknown;
}

function runOperation(
  operation: OperationNode,
  variables: Record<string, unknown>,
  store: Store,
  baseUrl: string,
  fragments: Map<string, FragmentDefNode>,
): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const ctx: ExecContext = { store, baseUrl, variables, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(operation.selections, rootType, ctx, fragments);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind !== 'field') continue;
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      data[key] = rootType;
      continue;
    }
    if (operation.operation === 'mutation') {
      const payload = executeMutation(selection, ctx);
      if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
      data[key] = payload === null ? null : executeSelections(selection.selections, payload.__typename, payload, ctx);
      continue;
    }
    if (selection.name === '__type' || selection.name === '__schema') {
      const value = resolveField(rootType, null, selection, ctx);
      data[key] = executeValue(value, selection, rootType, ctx);
      continue;
    }
    const value = resolveRootField(selection, ctx);
    data[key] = executeValue(value, selection, rootType, ctx);
  }
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data, errors: [] };
}

export function handleGraphQL(store: Store, baseUrl: string, body: unknown): GraphQLReply {
  const runOne = (operation: unknown): { data: Record<string, unknown> | null; errors: { message: string }[] } => {
    if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
      return { data: null, errors: [{ message: 'A GraphQL operation needs a query string.' }] };
    }
    const { query, variables, operationName } = operation as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof query !== 'string' || query.trim() === '') {
      return { data: null, errors: [{ message: 'A GraphQL operation needs a query string.' }] };
    }
    let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentDefNode> };
    try {
      parsed = new Parser(query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL syntax error' }] };
    }
    if (parsed.operations.length === 0) {
      return { data: null, errors: [{ message: 'The document holds no operation.' }] };
    }
    let chosen = parsed.operations[0]!;
    if (typeof operationName === 'string' && operationName !== '') {
      const named = parsed.operations.find((candidate) => candidate.name === operationName);
      if (named === undefined) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
      chosen = named;
    }
    const vars = variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
    return runOperation(chosen, vars, store, baseUrl, parsed.fragments);
  };

  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => runOne(entry)) };
  }
  return { status: 200, body: runOne(body) };
}
