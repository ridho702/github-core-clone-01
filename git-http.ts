// git-http.ts — git smart HTTP: info/refs (v0 and v2), upload-pack (v0 and v2) and
// receive-pack (v0). The wire shapes follow git's protocol and the env client's parsers.

import {
  decodePktLines,
  isAncestor,
  pktLine,
  pktLines,
  readPack,
  readPktLinesUntilFlush,
  verifyPackChecksum,
  writePack,
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  type Pkt,
} from './git.ts';
import {
  ackForFetch,
  objectsForFetch,
  type Repo,
  type Store,
} from './store.ts';

const AGENT = 'github-core-clone-01/1.0.0';
const UPLOAD_V2_CAPS = ['agent=' + AGENT, 'ls-refs', 'fetch=shallow wait-for-done', 'object-format=sha1'];
const UPLOAD_V0_CAPS = (symref: string): string =>
  `symref=${symref} multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not agent=${AGENT}`;
const RECEIVE_V0_CAPS = (symref: string): string =>
  `report-status report-status-v2 side-band-64k delete-refs symref=${symref} agent=${AGENT}`;

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
}

function badRequest(message: string): GitResponse {
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

/** The default branch's symref target, e.g. refs/heads/main. */
function defaultRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function symrefCap(repo: Repo): string {
  return `HEAD:${defaultRef(repo)}`;
}

/** All refs, sorted by name. */
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The commit an annotated tag object points at, or null. */
function tagTarget(repo: Repo, tagOid: string): string | null {
  const obj = repo.objects.get(tagOid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const text = obj.data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

export function infoRefs(store: Store, owner: string, name: string, service: 'git-upload-pack' | 'git-receive-pack', version2: boolean): GitResponse {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return notFound();
  const serviceLine = `# service=${service}\n`;
  const advertisementType = `application/x-${service}-advertisement`;
  if (version2 && service === 'git-upload-pack') {
    const parts: Buffer[] = [
      pktLine(serviceLine),
      PKT_FLUSH,
      pktLine('version 2\n'),
      ...UPLOAD_V2_CAPS.map((cap) => pktLine(`${cap}\n`)),
      PKT_FLUSH,
    ];
    return ok(advertisementType, Buffer.concat(parts));
  }
  // v0: service preamble, then ref lines; capabilities ride the first line after a NUL.
  const refs = sortedRefs(repo);
  const caps = service === 'git-receive-pack' ? RECEIVE_V0_CAPS(symrefCap(repo)) : UPLOAD_V0_CAPS(symrefCap(repo));
  const lines: Buffer[] = [pktLine(serviceLine), PKT_FLUSH];
  const defaultTip = repo.refs.get(defaultRef(repo));
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (defaultTip !== undefined) {
      lines.push(pktLine(`${defaultTip} HEAD\0${first ? caps : ''}\n`));
      first = false;
    }
    for (const ref of refs) {
      const suffix = first ? `\0${caps}` : '';
      first = false;
      lines.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      const peeled = tagTarget(repo, ref.oid);
      if (peeled !== null) lines.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  lines.push(PKT_FLUSH);
  return ok(advertisementType, Buffer.concat(lines));
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: Pkt[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, prefixes: [] };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.data.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: Buffer[] = [];
  const defaultTip = repo.refs.get(defaultRef(repo));
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (args.prefixes.length === 0) {
    if (defaultTip !== undefined) {
      lines.push(pktLine(`${defaultTip} HEAD symref-target:${defaultRef(repo)}\n`));
    } else {
      lines.push(pktLine(`unborn HEAD symref-target:${defaultRef(repo)}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const peeled = tagTarget(repo, ref.oid);
    if (peeled !== null) line += ` peeled:${peeled}`;
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------------------
// fetch (v2)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(packets: Pkt[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.data.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

/** Wrap pack bytes in sideband band-1 pkt-lines (chunks small enough for the 64k frame). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

function fetchV2Response(repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  const ack = ackForFetch(repo, args.wants, args.haves);
  parts.push(pktLine(ack !== null ? `ACK ${ack}\n` : 'NAK\n'));
  parts.push(PKT_DELIM);
  const { oids, shallow, unshallow } = objectsForFetch(repo, args.wants, args.haves, args.depth, args.shallow);
  if (args.depth !== null) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (oids.length > 0) {
    const pack = writePack(repo.objects, oids);
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch (v0)
// ---------------------------------------------------------------------------

function fetchV0Response(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const parts: Buffer[] = [];
  const ack = ackForFetch(repo, wants, haves);
  parts.push(pktLine(ack !== null ? `ACK ${ack}\n` : 'NAK\n'));
  const { oids } = objectsForFetch(repo, wants, haves, null);
  if (oids.length > 0) {
    const pack = writePack(repo.objects, oids);
    parts.push(sidebandPack(pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack entry point
// ---------------------------------------------------------------------------

export function uploadPack(store: Store, owner: string, name: string, body: Buffer, version2: boolean): GitResponse {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return notFound();
  try {
    if (!version2) {
      return ok('application/x-git-upload-pack-result', fetchV0Response(repo, body));
    }
    const packets = decodePktLines(body);
    let command = '';
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const line = packet.data.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('command=')) command = line.slice('command='.length);
      if (packet.kind === 'data' && line === '') break;
    }
    if (command === 'ls-refs') {
      return ok('application/x-git-upload-pack-result', lsRefsResponse(repo, parseLsRefsArgs(packets)));
    }
    if (command === 'fetch') {
      return ok('application/x-git-upload-pack-result', fetchV2Response(repo, parseFetchArgs(packets)));
    }
    return badRequest(`unknown upload-pack command ${JSON.stringify(command)}`);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'malformed upload-pack request');
  }
}

// ---------------------------------------------------------------------------
// receive-pack (v0)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function receivePack(store: Store, owner: string, name: string, body: Buffer): Promise<GitResponse> {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return notFound();
  try {
    const { packets, rest } = readPktLinesUntilFlush(body);
    const commands: PushCommand[] = [];
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const line = packet.data.toString('utf8').replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      const [oldOid, newOid, ref] = parts as [string, string, string];
      // Capabilities may ride the first command line after a NUL; drop them.
      const cleanRef = ref.split('\0')[0]!;
      commands.push({ oldOid: oldOid!, newOid: newOid!, ref: cleanRef });
    }
    if (commands.length === 0) return badRequest('receive-pack sent no commands');
    // Unpack first: a refused ref must still unpack, and a bad pack refuses everything.
    let unpackError: string | null = null;
    if (rest.length > 0) {
      try {
        if (!verifyPackChecksum(rest)) throw new Error('pack checksum mismatch');
        await readPack(rest, repo.objects);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : 'unpack failed';
      }
    }
    const reportLines: string[] = [];
    if (unpackError !== null) {
      reportLines.push(`unpack ${unpackError}\n`);
    } else {
      reportLines.push('unpack ok\n');
      for (const command of commands) {
        const result = applyPushCommand(repo, command);
        reportLines.push(result.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${result.reason}\n`);
      }
    }
    const report = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
    const framed = Buffer.concat([sidebandPack(report), PKT_FLUSH]);
    return ok('application/x-git-receive-pack-result', framed);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'malformed receive-pack request');
  }
}

/** Validate one push command against the ref state and apply it when it passes. */
function applyPushCommand(repo: Repo, command: PushCommand): { ok: boolean; reason?: string } {
  const current = repo.refs.get(command.ref);
  const isTag = command.ref.startsWith('refs/tags/');
  if (command.newOid === ZERO_OID) {
    // Delete: the old oid must match the current tip.
    if (current === undefined) return { ok: false, reason: 'ref does not exist' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return { ok: false, reason: 'old oid mismatch' };
    repo.refs.delete(command.ref);
    return { ok: true };
  }
  const obj = repo.objects.get(command.newOid);
  if (obj === undefined) return { ok: false, reason: 'object not found' };
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return { ok: false, reason: 'ref already exists' };
    repo.refs.set(command.ref, command.newOid);
    return { ok: true };
  }
  if (current === undefined) return { ok: false, reason: 'ref does not exist' };
  if (command.oldOid !== current) return { ok: false, reason: 'old oid mismatch' };
  if (!isTag && obj.type === 'commit') {
    if (!isAncestor(repo.objects, current, command.newOid)) {
      return { ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(command.ref, command.newOid);
  return { ok: true };
}

/**
 * Route one git-over-HTTP request to the right handler. The env client decides the
 * protocol version by sending `Git-Protocol: version=2`; without it the request is v0.
 * Git endpoints do not enforce the bearer token (the git client never sends one).
 */
export async function handleGitHttp(
  store: Store,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
): Promise<GitResponse> {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (match === null) return notFound();
  const owner = match[1]!;
  const name = match[2]!;
  const action = match[3]!;
  const protocol = typeof headers['git-protocol'] === 'string' ? headers['git-protocol'] : '';
  const version2 = protocol.includes('version=2');

  if (action === 'info/refs') {
    if (method !== 'GET') return badRequest('info/refs needs GET');
    const service = searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return badRequest('service is required');
    return infoRefs(store, owner, name, service, version2);
  }
  if (action === 'git-upload-pack') {
    if (method !== 'POST') return badRequest('git-upload-pack needs POST');
    return uploadPack(store, owner, name, body, version2);
  }
  if (method !== 'POST') return badRequest('git-receive-pack needs POST');
  return receivePack(store, owner, name, body);
}
