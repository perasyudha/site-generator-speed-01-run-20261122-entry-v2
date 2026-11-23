// Faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Same answers byte for byte; faster by (1) a single-pass inline renderer that
// batches plain runs instead of escaping one character at a time, (2) a
// first-character dispatch lexer instead of a regex battery per line, (3) a fused
// lex+render pass with no token objects, (4) front matter parsed without
// splitting + rejoining the whole body, (5) a per-build slug/long-date cache,
// (6) template rendering into an array joined once, (7) one card computed per
// source and reused. No cross-case state: every cache is created inside build().

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const RESERVED = Object.freeze(['posts', 'tags', 'page']);
export const REPORT_FILE = 'build-report.txt';

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
export function escapeHtml(text) {
  // Most values hold no escapable character: one test scan, no allocation.
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

export const SLUG_MAX = 64;
function slugify(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

// Same refusals as the reference, but the body is sliced out of the text
// instead of splitting the whole source into lines and joining it back.
function parseFrontMatter(text) {
  const firstNL = text.indexOf('\n');
  const firstLine = firstNL === -1 ? text : text.slice(0, firstNL);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (firstNL === -1) return { error: 'the front matter is not closed' };
  // First line exactly '---' after line 0: either '\n---\n' or a trailing '\n---'.
  let closeStart = -1;
  let bodyStart = -1;
  const mid = text.indexOf('\n---\n', firstNL);
  if (mid !== -1) {
    closeStart = mid + 1;
    bodyStart = mid + 5;
  } else if (text.endsWith('\n---')) {
    closeStart = text.length - 3;
    bodyStart = text.length;
  } else return { error: 'the front matter is not closed' };
  const segment = text.slice(firstNL + 1, closeStart);
  const fmLines = segment === '' ? [] : segment.split('\n');
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${j + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const isLangChar = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-';
const isSpaceTab = (c) => c === ' ' || c === '\t';

function isBlank(line) {
  for (let i = 0; i < line.length; i++) if (!isSpaceTab(line[i])) return false;
  return true;
}

// Fence open: '```' + lang chars + spaces/tabs only. Returns the lang, or undefined.
function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return undefined;
  let j = 3;
  while (j < line.length && isLangChar(line[j])) j++;
  const lang = line.slice(3, j);
  while (j < line.length && isSpaceTab(line[j])) j++;
  return j === line.length ? lang : undefined;
}

function fenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let j = 3; j < line.length; j++) if (!isSpaceTab(line[j])) return false;
  return true;
}

// Heading: 1-6 '#' + space/tab + non-empty text (trailing spaces/tabs dropped).
function headingOf(line) {
  if (line[0] !== '#') return null;
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n > 6 || n >= line.length || !isSpaceTab(line[n])) return null;
  let end = line.length;
  while (end > n + 1 && isSpaceTab(line[end - 1])) end--;
  const text = line.slice(n + 1, end);
  return text === '' ? null : { depth: n, text };
}

function isHr(line) {
  const c = line[0];
  if (c !== '-' && c !== '*') return false;
  const triple = c === '-' ? '---' : '***';
  if (!line.startsWith(triple)) return false;
  for (let j = 3; j < line.length; j++) if (!isSpaceTab(line[j])) return false;
  return true;
}

// Whether a line ends a paragraph: blank, fence, heading or thematic break.
function endsParagraph(line) {
  if (line === '') return true;
  const c = line[0];
  if (c === ' ' || c === '\t') return isBlank(line);
  if (c === '`') return fenceOpen(line) !== undefined;
  if (c === '#') return headingOf(line) !== null;
  if (c === '-' || c === '*') return isHr(line);
  return false;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && isSpaceTab(line[a])) a++;
  while (b > a && isSpaceTab(line[b - 1])) b--;
  return line.slice(a, b);
}

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// One regex pass: it matches every character that needs escaping or handling,
// so the runs between matches are pushed raw, with no escaping at all.
const INLINE_RE = /[&<>"'\\`*\[]/g;

function inlineInto(s, env, out) {
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_RE.exec(s)) !== null) {
    const j = m.index;
    const c = m[0];
    if (j > last) out.push(s.slice(last, j));
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      out.push(ESCAPES[c]);
      last = j + 1;
    } else if (c === '\\') {
      if (j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
        const n = s[j + 1];
        out.push(ESCAPES[n] ?? n);
        last = j + 2;
      } else {
        out.push('\\');
        last = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        last = k + 1;
      } else {
        out.push('`');
        last = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out.push('<strong>');
          inlineInto(s.slice(j + 2, k), env, out);
          out.push('</strong>');
          last = k + 2;
        } else {
          out.push('**');
          last = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out.push('<em>');
          inlineInto(s.slice(j + 1, k), env, out);
          out.push('</em>');
          last = k + 1;
        } else {
          out.push('*');
          last = j + 1;
        }
      }
    } else { // '['
      const k = findUnescaped(s, ']', j + 1);
      const close = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = close === -1 ? '' : s.slice(k + 2, close);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineInto(s.slice(j + 1, k), env, out);
        out.push('</a>');
        last = close + 1;
      } else {
        out.push('[');
        last = j + 1;
      }
    }
    INLINE_RE.lastIndex = last;
  }
  if (last < s.length) out.push(s.slice(last));
}

function renderMarkdown(src, env, slugOf) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line[0];
    if (c0 === ' ' || c0 === '\t') {
      if (isBlank(line)) {
        i++;
        continue;
      }
      // Indented non-blank line: a paragraph line (indented lines are not code).
    } else if (c0 === '`') {
      const lang = fenceOpen(line);
      if (lang !== undefined) {
        const body = [];
        i++;
        while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>${body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`}</code></pre>\n`);
        continue;
      }
    } else if (c0 === '#') {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugOf(h.text), ids);
        blocks.push(`<h${h.depth} id="${id}">`);
        const mark = blocks.length;
        inlineInto(h.text, env, blocks);
        const end = blocks.length;
        blocks.push(`</h${h.depth}>\n`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: blocks.slice(mark, end).join('') });
        i++;
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (isHr(line)) {
        blocks.push('<hr>\n');
        i++;
        continue;
      }
    } else if (c0 === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        const l = lines[i++];
        body.push(l[1] === ' ' ? l.slice(2) : l.slice(1));
      }
      const trimmed = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') trimmed.push(t);
      }
      if (trimmed.length === 0) blocks.push('<blockquote>\n</blockquote>\n');
      else {
        blocks.push('<blockquote>\n<p>');
        inlineInto(trimmed.join('\n'), env, blocks);
        blocks.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    // List or paragraph.
    let isOrdered = false;
    let start = 1;
    let firstText = null;
    if (c0 === '-' || c0 === '*') {
      if (line[1] === ' ') {
        firstText = trimLine(line.slice(2));
      }
    } else if (c0 >= '0' && c0 <= '9') {
      let j = 0;
      while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
      if (j >= 1 && j <= 9 && line[j] === '.' && line[j + 1] === ' ') {
        isOrdered = true;
        start = Number(line.slice(0, j));
        firstText = trimLine(line.slice(j + 2));
      }
    }
    if (firstText !== null) {
      const items = [[firstText]];
      i++;
      while (i < n) {
        const l = lines[i];
        let m = null;
        if (isOrdered) {
          if (l[0] >= '0' && l[0] <= '9') {
            let j = 0;
            while (j < l.length && l[j] >= '0' && l[j] <= '9') j++;
            if (j >= 1 && j <= 9 && l[j] === '.' && l[j + 1] === ' ') m = trimLine(l.slice(j + 2));
          }
        } else if ((l[0] === '-' || l[0] === '*') && l[1] === ' ') {
          m = trimLine(l.slice(2));
        }
        if (m !== null) {
          items.push([m]);
          i++;
        } else if (l[0] === ' ' && l[1] === ' ') {
          // Continued: two or more spaces, then a non-space, non-tab.
          let sp = 0;
          while (sp < l.length && l[sp] === ' ') sp++;
          if (sp >= 2 && sp < l.length && l[sp] !== '\t') {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      const parts = [open, '\n'];
      for (const item of items) {
        parts.push('<li>');
        inlineInto(item.join('\n'), env, parts);
        parts.push('</li>\n');
      }
      parts.push(`</${tag}>\n`);
      blocks.push(parts.join(''));
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    blocks.push('<p>');
    const mark = blocks.length;
    inlineInto(text, env, blocks);
    const end = blocks.length;
    blocks.push('</p>\n');
    if (excerpt === null) excerpt = blocks.slice(mark, end).join('');
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates
// Templates are precompiled to JS functions (v2): each template becomes
// fn(R, O) where R is the root-vars object and O the output array. Includes
// are inlined at compile time (depth-capped at 8, exactly like the
// interpreter), loop variables become JS locals, and `loop` objects are
// allocated only when the loop body references them. Paths resolve to direct
// property access with the reference's own-property semantics.

export const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

export class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Chained own-property walk for paths of 3+ segments (rare: page.newer.url).
function getPath(v, ...segs) {
  for (let k = 0; k < segs.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, segs[k])) return undefined;
    v = v[segs[k]];
  }
  return v;
}

// Does this for-node's body use the enclosing loop's `loop` object? The body
// is scanned, but a nested for's BODY is not (its `loop` is its own object);
// a nested for's iterable path and if paths are evaluated in this scope, so
// they count. Includes inherit the scope, so they are scanned transitively
// (depth-capped, like the interpreter).
function bodyUsesLoop(nodes, templates, depth) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw') {
      if (n.path[0] === 'loop') return true;
    } else if (n.kind === 'if') {
      if (n.path[0] === 'loop') return true;
      if (bodyUsesLoop(n.then, templates, depth)) return true;
      if (n.else !== null && bodyUsesLoop(n.else, templates, depth)) return true;
    } else if (n.kind === 'for') {
      if (n.path[0] === 'loop') return true;
      // Body not scanned: its `loop` is the inner loop's own object.
    } else if (n.kind === 'include') {
      if (depth < INCLUDE_DEPTH) {
        const t = templates.get(n.name);
        if (t !== undefined && bodyUsesLoop(t, templates, depth + 1)) return true;
      }
    }
  }
  return false;
}

// JS expression for a path. frames: innermost-last [{elem, elemVar, loopVar}].
// First segment: innermost loop binding wins (`loop` resolves to the loop
// object, which takes precedence over an element named `loop`, exactly like
// the reference frame's `{[name]: element, loop: {...}}`); otherwise the
// root-vars object R, own-property only. Later segments: own-property walk.
function genPathExpr(path, frames) {
  const first = path[0];
  let base = null;
  for (let i = frames.length - 1; i >= 0; i--) {
    const fr = frames[i];
    if (first === 'loop' && fr.loopVar !== null) {
      base = fr.loopVar;
      break;
    }
    if (fr.elem === first) {
      base = fr.elemVar;
      break;
    }
  }
  if (base === null) base = `(Object.hasOwn(R,${JSON.stringify(first)})?R[${JSON.stringify(first)}]:undefined)`;
  if (path.length === 1) return base;
  if (path.length === 2) {
    const seg = JSON.stringify(path[1]);
    return `(${base}!==null&&typeof ${base}==='object'&&Object.hasOwn(${base},${seg})?${base}[${seg}]:undefined)`;
  }
  return `getp(${base},${path.slice(1).map((s) => JSON.stringify(s)).join(',')})`;
}

function genNodes(nodes, frames, depth, templates, ctr, cacheable) {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') out += `O.push(${JSON.stringify(n.text)});\n`;
    else if (n.kind === 'var') out += `O.push(esc(txt(${genPathExpr(n.path, frames)})));\n`;
    else if (n.kind === 'raw') out += `O.push(txt(${genPathExpr(n.path, frames)}));\n`;
    else if (n.kind === 'if') {
      out += `if(${n.not ? '!' : ''}truthy(${genPathExpr(n.path, frames)})){\n${genNodes(n.then, frames, depth, templates, ctr, cacheable)}\n}`;
      if (n.else !== null) out += `else{\n${genNodes(n.else, frames, depth, templates, ctr, cacheable)}\n}`;
      out += '\n';
    } else if (n.kind === 'for') {
      const id = ctr.n++;
      const xs = `_x${id}`;
      const k = `_k${id}`;
      const v = `_v${id}`;
      const l = `_l${id}`;
      // An element named `loop` is shadowed by the loop object in the
      // reference frame, so the loop object must exist then.
      const needLoop = n.name === 'loop' || bodyUsesLoop(n.body, templates, depth);
      out += `{const ${xs}=${genPathExpr(n.path, frames)};if(Array.isArray(${xs})){for(let ${k}=0;${k}<${xs}.length;${k}++){const ${v}=${xs}[${k}];`;
      if (needLoop) out += `const ${l}={index:${k}+1,first:${k}===0,last:${k}===${xs}.length-1,length:${xs}.length};`;
      out += `\n${genNodes(n.body, [...frames, { elem: n.name, elemVar: v, loopVar: needLoop ? l : null }], depth, templates, ctr, cacheable)}\n}}}\n`;
    } else if (n.kind === 'include') {
      if (cacheable.has(n.name)) {
        // Rendered once per case from the case-constant root (see
        // analyzeCacheable): its output cannot vary between renders.
        out += `O.push(__c(${JSON.stringify(n.name)}));\n`;
      } else if (depth < INCLUDE_DEPTH) {
        const t = templates.get(n.name);
        if (t !== undefined) out += genNodes(t, frames, depth + 1, templates, ctr, cacheable);
      }
    }
  }
  return out;
}

// Compile every parsed template to fn(R, O). One new Function per case; the
// generated source holds the template text as string literals.
export function compileTemplates(templates, cacheable, getConst) {
  const entries = [];
  for (const [name, nodes] of templates) {
    const ctr = { n: 0 };
    entries.push(`[${JSON.stringify(name)},function(R,O){\n${genNodes(nodes, [], 0, templates, ctr, cacheable)}\n}]`);
  }
  const factory = new Function('esc', 'txt', 'truthy', 'getp', '__c', `return new Map([\n${entries.join(',\n')}\n]);`);
  return factory(escapeHtml, textOf, truthy, getPath, getConst);
}

// ---------------------------------------------------------------- fragment cache
// A template whose output depends only on the case-constant roots (site,
// tags, recent) renders identically on every call within a case, so it is
// rendered once and reused. Soundness conditions, all checked here:
//  - every path it uses (transitively through includes) resolves only
//    through {site, tags, recent}, through loop variables bound inside it
//    over such paths, or to undefined (an unknown name). A path through
//    page/posts/pager/tag, through a loop variable that any template binds
//    (it could be bound by a caller's for at an include site), or through
//    `loop` outside its own for, disqualifies it.
//  - the include graph has no cycle and its longest chain is at most 8
//    templates, so the interpreter's depth cap (8) can never bind anywhere
//    and a fragment's output is depth-independent. If either fails, no
//    template is cached at all.

const CONST_ROOTS = new Set(['site', 'tags', 'recent']);
const RENDER_ROOTS = new Set(['page', 'posts', 'pager', 'tag']);

function pathIsConstant(path, frames, loopConst, loopNames) {
  const f = path[0];
  if (f === 'loop') return loopConst;
  for (let i = frames.length - 1; i >= 0; i--) if (frames[i].elem === f) return frames[i].elemConst;
  if (CONST_ROOTS.has(f)) return true;
  if (loopNames.has(f)) return false;
  if (RENDER_ROOTS.has(f)) return false;
  return true; // unknown name: undefined everywhere, hence constant
}

function nodesAreConstant(nodes, templates, loopNames, frames, loopConst, depth) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!pathIsConstant(n.path, frames, loopConst, loopNames)) return false;
    } else if (n.kind === 'if') {
      if (!pathIsConstant(n.path, frames, loopConst, loopNames)) return false;
      if (!nodesAreConstant(n.then, templates, loopNames, frames, loopConst, depth)) return false;
      if (n.else !== null && !nodesAreConstant(n.else, templates, loopNames, frames, loopConst, depth)) return false;
    } else if (n.kind === 'for') {
      const pConst = pathIsConstant(n.path, frames, loopConst, loopNames);
      if (!nodesAreConstant(n.body, templates, loopNames, [...frames, { elem: n.name, elemConst: pConst }], pConst, depth)) return false;
    } else if (n.kind === 'include') {
      if (depth < INCLUDE_DEPTH) {
        const t = templates.get(n.name);
        // The callee is analysed with empty frames: a caller's loop bindings
        // are unknown here, so any name a for binds anywhere disqualifies
        // (see pathIsConstant's loopNames rule).
        if (t !== undefined && !nodesAreConstant(t, templates, loopNames, [], false, depth + 1)) return false;
      }
    }
  }
  return true;
}

export function analyzeCacheable(templates) {
  // Include graph: longest chain + cycle check.
  const graph = new Map();
  for (const [name, nodes] of templates) {
    const incs = new Set();
    const walk = (ns) => {
      for (const n of ns) {
        if (n.kind === 'include') incs.add(n.name);
        else if (n.kind === 'if') { walk(n.then); if (n.else !== null) walk(n.else); }
        else if (n.kind === 'for') walk(n.body);
      }
    };
    walk(nodes);
    graph.set(name, [...incs].filter((m) => templates.has(m)));
  }
  const memo = new Map();
  const state = new Map(); // 1 = in stack, 2 = done
  let cyclic = false;
  const longest = (name) => {
    if (memo.has(name)) return memo.get(name);
    if (state.get(name) === 1) {
      cyclic = true;
      return 0;
    }
    state.set(name, 1);
    let best = 1;
    for (const m of graph.get(name)) best = Math.max(best, 1 + longest(m));
    state.set(name, 2);
    memo.set(name, best);
    return best;
  };
  let maxChain = 0;
  for (const name of graph.keys()) maxChain = Math.max(maxChain, longest(name));
  if (cyclic || maxChain > INCLUDE_DEPTH) return new Set();

  const loopNames = new Set();
  const collect = (ns) => {
    for (const n of ns) {
      if (n.kind === 'for') { loopNames.add(n.name); collect(n.body); }
      else if (n.kind === 'if') { collect(n.then); if (n.else !== null) collect(n.else); }
    }
  };
  for (const nodes of templates.values()) collect(nodes);

  const out = new Set();
  for (const [name, nodes] of templates) {
    if (nodesAreConstant(nodes, templates, loopNames, [], false, 0)) out.add(name);
  }
  return out;
}

// ---------------------------------------------------------------- the build

function wordsOf(text) {
  // Same count as text.match(/\S+/g).length, but without the match array:
  // one scan, counting whitespace-to-word transitions. ASCII whitespace is
  // checked by code; anything >= 0x80 goes through /\s/ so Unicode spaces
  // (U+00A0, U+3000, ...) count exactly as \S counts them.
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const ws = code < 128 ? code === 32 || (code >= 9 && code <= 13) : /\s/.test(text[i]);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function build(input) {
  const slugCache = new Map();
  const slugOf = (t) => {
    let s = slugCache.get(t);
    if (s === undefined) {
      s = slugify(t);
      slugCache.set(t, s);
    }
    return s;
  };
  const dateCache = new Map();
  const longOf = (d) => {
    let s = dateCache.get(d);
    if (s === undefined) {
      s = longDate(d);
      dateCache.set(d, s);
    }
    return s;
  };

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const cacheable = analyzeCacheable(templates);

  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    output: {},
    slugOf,
    longOf,
  };

  // 1. Sources, sorted by path; CR line ends made '\n' (skipped when none).
  {
    const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
    for (const f of files) {
      if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
      else b.statics.push({ path: f.path, content: f.content });
    }
  }

  // 2. Front matter.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Permalinks.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Markdown.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
          if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
          b.broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env, slugOf);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. Collections.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. Tags.
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      return (s.data.tags ?? []).filter((name) => !seen.has(slugOf(name)) && seen.add(slugOf(name)));
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugOf(name);
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugOf(name)) ?? { name, slug: slugOf(name), url: '', posts: [] });
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  // 7. Layouts.
  {
    const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longOf(s.data.date) });
    const cardOf = (s) => ({
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longOf(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    });
    for (const s of b.sources) s.card = cardOf(s);
    const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) });
    const pageOf = (s) => ({
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    });
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => p.card);
    const constCache = new Map();
    const constRoot = { site, tags: allTags, recent };
    let compiled;
    const getConst = (name) => {
      let s = constCache.get(name);
      if (s === undefined) {
        const fn = compiled.get(name);
        const out = [];
        fn(constRoot, out);
        s = out.join('');
        constCache.set(name, s);
      }
      return s;
    };
    compiled = compileTemplates(templates, cacheable, getConst);
    const render = (name, vars) => {
      const fn = compiled.get(name);
      if (fn === undefined) return null;
      const out = [];
      fn({ site, tags: allTags, recent, ...vars }, out);
      return out.join('');
    };
    for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => p.card),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. Report.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }

  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
