// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, whether it ends with one (SPEC.md section 3). */
interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions where O occurs in lines at the given tier (overlaps allowed). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0..2, or only 0 when strict) at which O occurs at least once, else -1. */
function findTier(lines: string[], o: string[], strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t += 1) {
    if (occurrences(lines, o, t).length > 0) return t;
  }
  return -1;
}

/** One body line of a unified hunk, SEARCH/REPLACE block or V4A chunk (SPEC.md section 5). */
type BodyLine = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };

/**
 * The lines that replace the matched segment: context lines are the file's own matched lines,
 * old lines are dropped, new lines are written as they are, re-indented at tier 2.
 */
function applyBody(file: FileLines, at: number, body: BodyLine[], tier: number): string[] {
  const out: string[] = [];
  const firstO = body.find((b) => b.kind === 'ctx' || b.kind === 'old');
  const f0 = file.lines[at] ?? '';
  const F = leadWs(f0);
  const P = firstO === undefined ? '' : leadWs(firstO.text);
  let oIdx = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push(file.lines[at + oIdx]!);
      oIdx += 1;
    } else if (b.kind === 'old') {
      oIdx += 1;
    } else if (b.kind === 'new') {
      let t = b.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

/** Whether a `\` line follows the hunk's last context or `+` line (SPEC.md section 6). */
function hunkNoNl(body: BodyLine[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j += 1) {
    if (body[j]!.kind === 'ctx' || body[j]!.kind === 'new') last = j;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === 'bs';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves applied so far, in order: the output names them as `R <old> -> <new>`. */
  readonly moves: [string, string][] = [];
  move(oldP: string, newP: string, content: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, content);
    this.moves.push([oldP, newP]);
  }
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function parseError(line: number): never {
  throw new Exit2(`error: parse ${line}`);
}

/** One unified hunk: its old start line (1-based), its body, whether it ends without a line break. */
interface UnifiedHunk {
  a: number;
  body: BodyLine[];
}

interface UnifiedSection {
  diffOld: string | null;
  diffNew: string | null;
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  create: boolean;
  remove: boolean;
  hunks: UnifiedHunk[];
}

/** Apply a section's hunks in order to a file's text (SPEC.md section 6). */
function applyUnifiedHunks(content: string, hunks: UnifiedHunk[], strict: boolean, path: string): string {
  const f = splitFile(content);
  let d = 0;
  for (const h of hunks) {
    const o = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'old').map((b) => b.text);
    const noNl = hunkNoNl(h.body);
    if (o.length === 0) {
      const at = Math.min(h.a + d, f.lines.length);
      const endReached = at === f.lines.length;
      const ins = h.body.filter((b) => b.kind === 'new').map((b) => b.text);
      f.lines.splice(at, 0, ...ins);
      if (endReached) f.final = !noNl;
      d += ins.length;
      continue;
    }
    const tier = findTier(f.lines, o, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occ = occurrences(f.lines, o, tier);
    const target = h.a - 1 + d;
    let best = occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const endReached = best + o.length === f.lines.length;
    const replacement = applyBody(f, best, h.body, tier);
    f.lines.splice(best, o.length, ...replacement);
    if (endReached) f.final = !noNl;
    d += replacement.length - o.length;
  }
  return joinFile(f);
}

function makeUnifiedEdit(sec: UnifiedSection, strict: boolean): Edit | null {
  const oldP = sec.hasPair ? sec.pairOld : (sec.renameOld ?? sec.diffOld);
  const newP = sec.hasPair ? sec.pairNew : (sec.renameNew ?? sec.diffNew);
  if (oldP === null && newP === null) return null;
  if (sec.create || oldP === null) {
    const p = newP!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noNl = false;
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
        if (h.body.some((b) => b.kind === 'new')) noNl = hunkNoNl(h.body);
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
    };
  }
  if (sec.remove || newP === null) {
    const p = oldP!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldP !== newP) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.move(oldP, newP, applyUnifiedHunks(cur, sec.hunks, strict, oldP));
    };
  }
  const p = oldP;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, applyUnifiedHunks(cur, sec.hunks, strict, p));
  };
}

/** Read a unified diff patch into its section edits (SPEC.md section 6). */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  const blankSection = (): UnifiedSection => ({
    diffOld: null,
    diffNew: null,
    hasPair: false,
    pairOld: null,
    pairNew: null,
    renameOld: null,
    renameNew: null,
    create: false,
    remove: false,
    hunks: [],
  });
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  const startSection = (): UnifiedSection => {
    const s = blankSection();
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  const stripPrefix = (t: string): string => {
    if (t.startsWith('a/')) return t.slice(2);
    if (t.startsWith('b/')) return t.slice(2);
    return t;
  };
  const pathOf = (line: string): string | null => {
    const t = stripPrefix(line.slice(4).split('\t')[0]!.trim());
    return t === '/dev/null' ? null : t;
  };
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) parseError(i + 1);
      const s = startSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.hasPair) {
        cur.pairOld = pathOf(line);
        cur.pairNew = pathOf(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        const s = startSection();
        s.pairOld = pathOf(line);
        s.pairNew = pathOf(lines[i + 1]!);
        s.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) parseError(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) parseError(i + 1);
      const hunk: UnifiedHunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      inHeader = false;
      i += 1;
      const raw: string[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          raw.push(b);
          i += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      hunk.body = raw.map((b): BodyLine => {
        if (b === '') return { kind: 'ctx', text: '' };
        if (b.startsWith(' ')) return { kind: 'ctx', text: b.slice(1) };
        if (b.startsWith('-')) return { kind: 'old', text: b.slice(1) };
        if (b.startsWith('+')) return { kind: 'new', text: b.slice(1) };
        return { kind: 'bs', text: b };
      });
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) parseError(i + 2);
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.remove = true;
    }
    i += 1;
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const e = makeUnifiedEdit(s, strict);
    if (e !== null) edits.push(e);
  }
  return edits;
}

/** Read a SEARCH/REPLACE patch into its block edits (SPEC.md section 7). */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const isMarker = (l: string, m: string): boolean => l.replace(/[ \t]+$/, '') === m;
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (!isMarker(lines[i]!, '<<<<<<< SEARCH')) {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!;
      if (t.trim() === '') continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) parseError(searchLine);
    let eq = -1;
    for (let j = i + 1; j < n; j += 1) {
      if (isMarker(lines[j]!, '<<<<<<< SEARCH')) break;
      if (isMarker(lines[j]!, '=======')) {
        eq = j;
        break;
      }
    }
    if (eq < 0) parseError(searchLine);
    let rep = -1;
    for (let j = eq + 1; j < n; j += 1) {
      if (isMarker(lines[j]!, '<<<<<<< SEARCH')) break;
      if (isMarker(lines[j]!, '>>>>>>> REPLACE')) {
        rep = j;
        break;
      }
    }
    if (rep < 0) parseError(searchLine);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = splitFile(cur);
      const tier = findTier(f.lines, oldLines, strict);
      if (tier < 0) throw new Fail('no-match', p);
      const occ = occurrences(f.lines, oldLines, tier);
      if (occ.length > 1) throw new Fail('ambiguous', p);
      const body: BodyLine[] = [
        ...oldLines.map((t): BodyLine => ({ kind: 'old', text: t })),
        ...newLines.map((t): BodyLine => ({ kind: 'new', text: t })),
      ];
      const replacement = applyBody(f, occ[0]!, body, tier);
      f.lines.splice(occ[0]!, oldLines.length, ...replacement);
      tree.now.set(p, joinFile(f));
    });
    prevEnd = rep + 1;
    prevPath = p;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: its anchor (null/empty: none), whether it is anchored to the end of the file. */
interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

/** Read a V4A patch into its section edits (SPEC.md section 8). */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) parseError(1);
  if (lines[first]!.trim() !== '*** Begin Patch') parseError(first + 1);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') parseError(lines.length + 1);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i += 1;
      const fileLines: string[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (isSectionStart(b)) break;
        if (b.startsWith('+')) {
          fileLines.push(b.slice(1));
          i += 1;
        } else if (b === '') {
          fileLines.push('');
          i += 1;
        } else parseError(i + 1);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last) {
        const b = lines[i]!;
        if (isSectionStart(b)) break;
        if (blank(b)) {
          i += 1;
          continue;
        }
        parseError(i + 1);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const endChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const b = lines[i]!;
        if (isSectionStart(b)) break;
        if (b.trim() === '*** End of File') {
          if (cur === null) parseError(i + 1);
          cur.eof = true;
          endChunk();
          i += 1;
          continue;
        }
        if (b.startsWith('@@')) {
          endChunk();
          cur = { anchor: b.slice(2).trim(), eof: false, body: [] };
          i += 1;
          continue;
        }
        if (b === '') {
          if (cur === null && chunks.length > 0) {
            i += 1;
            continue;
          }
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push({ kind: 'ctx', text: '' });
          i += 1;
          continue;
        }
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) parseError(i + 1);
            cur = { anchor: null, eof: false, body: [] };
          }
          if (b.startsWith(' ')) cur.body.push({ kind: 'ctx', text: b.slice(1) });
          else if (b.startsWith('-')) cur.body.push({ kind: 'old', text: b.slice(1) });
          else cur.body.push({ kind: 'new', text: b.slice(1) });
          i += 1;
          continue;
        }
        parseError(i + 1);
      }
      endChunk();
      const lastChunk = chunks[chunks.length - 1];
      if (lastChunk !== undefined) {
        while (lastChunk.body.length > 0) {
          const lb = lastChunk.body[lastChunk.body.length - 1]!;
          if (lb.kind === 'ctx' && lb.text === '') lastChunk.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) parseError(updateLine);
      const p = path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const curText = tree.get(p);
        if (curText === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const f = splitFile(curText);
        let cursor = 0;
        for (const ch of chs) {
          if (ch.anchor !== null && ch.anchor !== '') {
            let at = -1;
            const max = strict ? 0 : 2;
            for (let t = 0; t <= max && at < 0; t += 1) {
              for (let j = cursor; j < f.lines.length; j += 1) {
                if (lineEq(f.lines[j]!, ch.anchor, t)) {
                  at = j;
                  break;
                }
              }
            }
            if (at < 0) throw new Fail('no-match', p);
            cursor = at + 1;
          }
          const o = ch.body.filter((b) => b.kind === 'ctx' || b.kind === 'old').map((b) => b.text);
          if (o.length === 0) {
            const ins = ch.body.filter((b) => b.kind === 'new').map((b) => b.text);
            const at = ch.eof ? f.lines.length : cursor;
            f.lines.splice(at, 0, ...ins);
            cursor = at + ins.length;
            continue;
          }
          let tier = -1;
          let occ: number[] = [];
          const max = strict ? 0 : 2;
          for (let t = 0; t <= max; t += 1) {
            const all = occurrences(f.lines, o, t).filter((q) => q >= cursor);
            if (all.length > 0) {
              tier = t;
              occ = all;
              break;
            }
          }
          if (tier < 0) throw new Fail('no-match', p);
          let at = occ[0]!;
          if (ch.eof) {
            const endOcc = occ.filter((q) => q + o.length === f.lines.length);
            if (endOcc.length === 0) throw new Fail('no-match', p);
            at = endOcc[0]!;
          }
          const replacement = applyBody(f, at, ch.body, tier);
          f.lines.splice(at, o.length, ...replacement);
          cursor = at + replacement.length;
        }
        const out = joinFile(f);
        if (mt !== null) tree.move(p, mt, out);
        else tree.now.set(p, out);
      });
      continue;
    }
    parseError(i + 1);
  }
  return edits;
}
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const oldWas = tree.original(oldP);
    const oldNow = tree.now.get(oldP);
    const newWas = tree.original(newP);
    const newNow = tree.now.get(newP);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      if (tree.original(p) === now) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
