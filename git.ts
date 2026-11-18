// git.ts — the git object model, pack codec, pkt-line codec and graph walks.
// Node standard library only. No dependency on the store: every function takes the
// objects map (oid -> {type, data}) it works on, so the same code serves the server
// and any test harness.

import { createHash } from 'node:crypto';
import { createInflate, deflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

/** The SHA-1 id of an object, as git computes it: sha1("<type> <len>\0" + bytes). */
export function oidOf(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object in `objects` (idempotent) and answer its oid. */
export function putObject(objects: Map<string, GitObject>, type: ObjType, data: Buffer): string {
  const oid = oidOf(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------------------
// Commits and trees
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers and message. Unknown headers are ignored. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  // Commit objects end the message with a newline; the API shows it without.
  const message = (split === -1 ? '' : text.slice(split + 2)).replace(/\n+$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build commit bytes. `author`/`committer` are "Name <email>"; the timestamp is appended. */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
  timestamp?: number;
}): Buffer {
  const ts = input.timestamp ?? Math.floor(Date.now() / 1000);
  const lines = [
    `tree ${input.tree}`,
    ...input.parents.map((parent) => `parent ${parent}`),
    `author ${input.author} ${ts} +0000`,
    `committer ${input.committer} ${ts} +0000`,
    '',
    input.message.endsWith('\n') ? input.message : `${input.message}\n`,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const mode = data.subarray(i, space).toString('utf8');
    const nul = data.indexOf(0, space);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

/** Build tree bytes, sorting entries the way git does (directories sort as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/**
 * Build (and store) the tree for a flat file map, returning the root tree oid.
 * `files` maps a repository-relative path to its blob oid and mode.
 */
export function treeFromFiles(
  files: ReadonlyMap<string, { oid: string; mode: string }>,
  objects: Map<string, GitObject>,
): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
  const rootNode = makeNode();
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = rootNode;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = makeNode();
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1]!, file);
  }
  const buildNode = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, oid: buildNode(sub) });
    return putObject(objects, 'tree', buildTree(entries));
  };
  return buildNode(rootNode);
}

/** Flatten a commit's tree into path -> {oid, mode}, following subtrees. */
export function flattenTree(objects: ReadonlyMap<string, GitObject>, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

// ---------------------------------------------------------------------------
// Graph walks
// ---------------------------------------------------------------------------

/** All commit oids reachable from `tips` (following parents), tips first. */
export function reachableCommits(
  objects: ReadonlyMap<string, GitObject>,
  tips: Iterable<string>,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

/** Every object reachable from `tips`: commits, their trees (recursively) and blobs. */
export function reachableObjects(
  objects: ReadonlyMap<string, GitObject>,
  tips: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  // Expand annotated-tag tips to their targets first (the tag object itself travels too).
  const seeds = new Set<string>();
  const expand = (oid: string): void => {
    if (seeds.has(oid)) return;
    seeds.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'tag') return;
    out.add(oid);
    const text = obj.data.toString('utf8');
    const head = text.split('\n\n')[0] ?? '';
    for (const line of head.split('\n')) {
      if (line.startsWith('object ')) expand(line.slice(7).trim());
    }
  };
  for (const tip of tips) expand(tip);
  const commits = reachableCommits(objects, seeds);
  const visitTree = (oid: string): void => {
    if (out.has(oid)) return;
    const obj = objects.get(oid);
    if (obj === undefined) return;
    out.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') visitTree(entry.oid);
        else out.add(entry.oid);
      }
    }
  };
  for (const commit of commits) {
    out.add(commit);
    const obj = objects.get(commit);
    if (obj !== undefined && obj.type === 'commit') visitTree(parseCommit(obj.data).tree);
  }
  return out;
}

/** True when `ancestor` is `descendant` or one of its ancestors. */
export function isAncestor(
  objects: ReadonlyMap<string, GitObject>,
  ancestor: string,
  descendant: string,
): boolean {
  if (ancestor === descendant) return true;
  return reachableCommits(objects, [descendant]).has(ancestor);
}

/** The merge base of two commits: the first common ancestor found walking from `b`. */
export function mergeBase(
  objects: ReadonlyMap<string, GitObject>,
  a: string,
  b: string,
): string | null {
  const ancestorsA = reachableCommits(objects, [a]);
  if (ancestorsA.has(b)) return b;
  const queue = [b];
  const seen = new Set<string>([b]);
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancestorsA.has(oid)) return oid;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

/** Commits reachable from `tip`, newest first (creation order is not tracked: walk parents depth-first). */
export function commitHistory(
  objects: ReadonlyMap<string, GitObject>,
  tip: string,
  limit = 1000,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pkt-line codec (git's framing for smart HTTP)
// ---------------------------------------------------------------------------

/** Encode one line (with its trailing \n when present) as a pkt-line. */
export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

/** Encode several lines, each its own pkt-line. */
export function pktLines(lines: readonly (string | Buffer)[]): Buffer {
  return Buffer.concat(lines.map((line) => pktLine(line)));
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Pkt =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole pkt-line stream into packets. Throws on a malformed length. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line length');
    const hex = buf.subarray(i, i + 4).toString('ascii');
    const len = parseInt(hex, 16);
    if (Number.isNaN(len)) throw new Error(`invalid pkt-line length ${JSON.stringify(hex)}`);
    if (len === 0) {
      out.push({ kind: 'flush' });
      i += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim' });
      i += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end' });
      i += 4;
    } else {
      if (i + len > buf.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
      i += len;
    }
  }
  return out;
}

/** Read pkt-lines from the front of `buf` until a flush; answer the packets and the rest. */
export function readPktLinesUntilFlush(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line length');
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('invalid pkt-line length');
    if (len === 0) {
      packets.push({ kind: 'flush' });
      return { packets, rest: buf.subarray(i + 4) };
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      i += 4;
      continue;
    }
    if (i + len > buf.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  throw new Error('pkt-line stream ended without a flush');
}

// ---------------------------------------------------------------------------
// Pack files
// ---------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Inflate one zlib stream at the front of `buf`; answer the bytes and how many input bytes it took. */
function inflateOne(buf: Buffer): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const inflater = createInflate();
    const chunks: Buffer[] = [];
    inflater.on('data', (chunk: Buffer) => chunks.push(chunk));
    inflater.on('error', reject);
    inflater.on('end', () => {
      const consumed = (inflater as unknown as { bytesWritten: number }).bytesWritten;
      resolve({ data: Buffer.concat(chunks), consumed });
    });
    inflater.end(buf);
  });
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[p++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const out: Buffer[] = [];
  while (p < delta.length) {
    const op = delta[p++]!;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if ((op & (1 << i)) !== 0) offset |= delta[p++]! << (8 * i);
      for (let i = 0; i < 3; i += 1) if ((op & (0x10 << i)) !== 0) size |= delta[p++]! << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
    } else if (op !== 0) {
      out.push(delta.subarray(p, p + op));
      p += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  ofsBase?: number;
  refBase?: string;
}

/**
 * Parse a pack file into objects and store them in `objects`.
 * Handles plain objects and OFS/REF deltas. Answers the oids stored, in pack order.
 */
export async function readPack(buf: Buffer, objects: Map<string, GitObject>): Promise<string[]> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a pack file');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const entries: RawPackEntry[] = [];
  let pos = 12;
  for (let n = 0; n < count; n += 1) {
    const offset = pos;
    let byte = buf[pos++]!;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[pos++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let ofsBase: number | undefined;
    let refBase: string | undefined;
    if (typeCode === 6) {
      byte = buf[pos++]!;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[pos++]!;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      ofsBase = offset - baseOffset;
    } else if (typeCode === 7) {
      refBase = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const { data, consumed } = await inflateOne(buf.subarray(pos));
    if (data.length !== size) throw new Error(`pack entry size mismatch (want ${size}, got ${data.length})`);
    pos += consumed;
    entries.push({ offset, typeCode, data, ofsBase, refBase });
  }
  // Resolve in order, with recursion for deltas whose base is itself a delta.
  const byOffset = new Map<number, RawPackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const resolved = new Map<number, { type: ObjType; data: Buffer }>();
  const resolve = (entry: RawPackEntry): { type: ObjType; data: Buffer } => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    let out: { type: ObjType; data: Buffer };
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.ofsBase!);
      if (baseEntry === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      out = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const baseObj = objects.get(entry.refBase!);
      if (baseObj !== undefined) {
        out = { type: baseObj.type, data: applyDelta(baseObj.data, entry.data) };
      } else {
        const baseEntry = entries.find((candidate) => oidOf(PACK_TYPES[candidate.typeCode] ?? 'blob', candidate.data) === entry.refBase);
        if (baseEntry !== undefined) {
          const base = resolve(baseEntry);
          out = { type: base.type, data: applyDelta(base.data, entry.data) };
        } else {
          throw new Error(`ref-delta base ${entry.refBase} not found`);
        }
      }
    } else {
      const type = PACK_TYPES[entry.typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${entry.typeCode}`);
      out = { type, data: entry.data };
    }
    resolved.set(entry.offset, out);
    return out;
  };
  const oids: string[] = [];
  for (const entry of entries) {
    const obj = resolve(entry);
    oids.push(putObject(objects, obj.type, obj.data));
  }
  return oids;
}

/** Serialise objects into a pack file (no deltas). `oids` selects the objects, in order. */
export function writePack(objects: ReadonlyMap<string, GitObject>, oids: readonly string[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of oids) {
    const obj = objects.get(oid);
    if (obj === undefined) throw new Error(`writePack: missing object ${oid}`);
    const typeCode = PACK_TYPE_CODES[obj.type];
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest !== 0) first |= 0x80;
    headerBytes.push(first);
    while (rest !== 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest !== 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    const entryHead = Buffer.from(headerBytes);
    const compressed = deflateSync(obj.data);
    const entry = Buffer.concat([entryHead, compressed]);
    parts.push(entry);
  }
  // The trailer is the SHA-1 of every byte before it (the 12-byte header + entries).
  const body = Buffer.concat(parts);
  const trailerHash = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailerHash]);
}

/** Verify a pack's trailing checksum and answer whether it matches. */
export function verifyPackChecksum(buf: Buffer): boolean {
  if (buf.length < 32) return false;
  const stored = buf.subarray(buf.length - 20);
  const actual = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  return stored.equals(actual);
}
