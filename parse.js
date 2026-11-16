// parse.js — dependency-free CommonMark + GFM renderer matching marked 18.1.3.
// Written fresh for markdown-render-speed-02. Architecture: block parser (reference
// algorithm over lines, container-aware) + inline parser (delimiter-stack emphasis)
// + renderer that mirrors marked's exact HTML output.

// ============================== helpers ==============================
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Escape &, <, >, ", ' (all of them).
function escapeAll(s) {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}
// Escape <, >, ", ' and & only when & is NOT part of an entity-like reference
// (&name; or &#123; or &#x1F;). This is marked's text escaping.
const NO_ENCODE_RE = /[<>\"']|&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g;
function escapeText(s) {
  return s.replace(NO_ENCODE_RE, (c) => ESC[c]);
}
// cleanUrl: marked's URL normalisation (encodeURI, keep %XX intact), null on error.
function cleanUrl(href) {
  try { href = encodeURI(href).replace(/%25/g, '%'); } catch (e) { return null; }
  return href;
}
// Decode a numeric character reference body (after '&#', before ';').
// Decimal 1-7 digits or hex 1-6 digits. 0, >0x10FFFF, surrogates -> U+FFFD. null if invalid.
function decodeNumericRef(body) {
  let cp;
  if (body.charCodeAt(0) === 120 || body.charCodeAt(0) === 88) { // x / X
    if (body.length < 2 || body.length > 7) return null;
    cp = parseInt(body.slice(1), 16);
  } else {
    if (body.length < 1 || body.length > 7) return null;
    for (let i = 0; i < body.length; i++) {
      const c = body.charCodeAt(i);
      if (c < 48 || c > 57) return null;
    }
    cp = parseInt(body, 10);
  }
  if (Number.isNaN(cp)) return null;
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
  return String.fromCodePoint(cp);
}
// Normalise a link label: trim, collapse whitespace runs to one space, case-fold.
function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}
function isSpace(c) { return c === ' ' || c === '\t'; }
function isPunct(c) {
  return c !== undefined && /[!-\/:-@\[-`{-~]/.test(c);
}
function isAlphaNum(c) {
  return c !== undefined && /[\p{L}\p{N}]/u.test(c);
}
function isBlankStr(s) { return /^[ \t]*$/.test(s); }

// Expand a tab at column `col` to its width (next multiple of 4).
function tabWidth(col) { return 4 - (col % 4); }

// ============================== link label / destination / title ==============================
// Find the matching ']' for the '[' at position `start` in `s` (s[start] === '[').
// Handles backslash escapes and balanced nested brackets (one level is enough for the
// CommonMark label rule, but we allow arbitrary nesting). Returns index just past ']',
// or -1 if no match. `allowNewline` — labels may span lines.
function findCloseBracket(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      // skip code span (backticks protect brackets inside); if there is no
      // matching closing run, the backticks are literal text, not a span
      // (advance by one; the loop increment moves past this backtick).
      let j = i, n = 0;
      while (s[j] === '`') { j++; n++; }
      const close = s.indexOf('`'.repeat(n), j);
      if (close === -1) { continue; }
      i = close + n - 1;
      continue;
    }
    if (c === '<') {
      // Skip an angle autolink or an inline HTML tag: brackets inside the
      // URL or a tag's quoted attribute values do not close the label.
      const al = matchAngleAutolink(s, i);
      if (al) { i = al.end - 1; continue; }
      const tm = INLINE_TAG_RE.exec(s.slice(i));
      if (tm) { i += tm[0].length - 1; continue; }
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
// Parse a link destination starting at index `i` in `s`.
// Returns { dest, end } (end = index just past the destination) or null.
// Destination is either <...> (no newline, no unescaped < or >) or a bare run
// (no spaces/control, balanced parens, backslash escapes allowed).
function parseDest(s, i) {
  if (s[i] === '<') {
    let j = i + 1, out = '';
    while (j < s.length) {
      const c = s[j];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return { dest: out, end: j + 1 };
      if (c === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c; j++;
    }
    return null;
  }
  // bare destination: no spaces, no control chars, balanced parens
  let j = i, out = '', depth = 0;
  while (j < s.length) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
    if (c === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (c === '(') { depth++; out += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; out += c; j++; continue;
    }
    out += c; j++;
  }
  if (j === i) return null;
  if (depth !== 0) return null;
  return { dest: out, end: j };
}
// Parse a link title starting at index `i` in `s`.
// Title is "..." or '...' or (...); it may span lines (newlines preserved).
// Returns { title, end } or null.
function parseTitle(s, i) {
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let j = i + 1, out = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (c === close) return { title: out, end: j + 1 };
    if (q === '(' && (c === '(' || c === ')')) return null;
    out += c; j++;
  }
  return null;
}
// Skip spaces/tabs, optionally one newline + spaces/tabs. Returns new index.
function skipSpaceNewline(s, i) {
  while (i < s.length && isSpace(s[i])) i++;
  if (s[i] === '\n') {
    i++;
    while (i < s.length && isSpace(s[i])) i++;
  }
  return i;
}
// Parse one link reference definition at the start of `s` (s starts at the def).
// Returns { label, href, title, end } (end = index just past the line ending) or null.
// The title must be separated from the destination by whitespace. If no valid
// title follows, the definition is destination-only and ends at its line.
// A reference label (in a definition or a `[text][ref]` / shortcut reference)
// must not be empty after whitespace collapsing, and must not contain an
// unescaped `[` or `]` (except inside a code span). Inline-link *text* may
// contain balanced brackets; reference labels may not.
function isValidRefLabel(label) {
  if (normalizeLabel(label) === '') return false;
  let i = 0;
  while (i < label.length) {
    const c = label[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let j = i, n = 0;
      while (label[j] === '`') { j++; n++; }
      const close = label.indexOf('`'.repeat(n), j);
      if (close === -1) { i++; continue; }
      i = close + n;
      continue;
    }
    if (c === '[' || c === ']') return false;
    i++;
  }
  return true;
}

function parseLinkDef(s) {
  let i = 0;
  while (i < s.length && isSpace(s[i])) i++;
  if (i > 3) return null;
  if (s[i] !== '[') return null;
  const close = findCloseBracket(s, i);
  if (close === -1) return null;
  const label = s.slice(i + 1, close - 1);
  if (label.length === 0) return null;
  if (!isValidRefLabel(label)) return null;
  i = close;
  if (s[i] !== ':') return null;
  i++;
  i = skipSpaceNewline(s, i);
  const d = parseDest(s, i);
  if (!d) return null;
  i = d.end;
  const destEnd = i;
  let title = null;
  let end = destEnd;
  // Try a title: it must be separated from the dest by whitespace.
  const afterDest = skipSpaceNewline(s, i);
  if (afterDest > i) {
    const t = parseTitle(s, afterDest);
    if (t) {
      let j = t.end;
      while (j < s.length && isSpace(s[j])) j++;
      if (j >= s.length || s[j] === '\n') {
        title = t.title;
        end = j;
        if (s[end] === '\n') end++;
      }
    }
  }
  if (title === null) {
    // No valid title: destination-only; only whitespace may follow on its line.
    let j = destEnd;
    while (j < s.length && isSpace(s[j])) j++;
    if (j < s.length && s[j] !== '\n') return null;
    end = j;
    if (s[end] === '\n') end++;
  }
  return { label: normalizeLabel(label), href: d.dest, title, end };
}
// Extract leading link reference definitions from a paragraph's raw text.
// Returns { defs: [{label, href, title}], rest: string }.
function extractLinkDefs(text) {
  const defs = [];
  let rest = text;
  for (;;) {
    const d = parseLinkDef(rest);
    if (!d) break;
    defs.push({ label: d.label, href: d.href, title: d.title });
    rest = rest.slice(d.end);
  }
  return { defs, rest };
}

// ============================== block parsing ==============================
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
const INLINE_TAGS = new Set(('a em strong small s cite q dfn abbr data time code var samp kbd sub sup i b u mark ruby rt rp bdi bdo span br wbr ins del img').split(' '));

function newBlock(t) {
  const b = { t, children: [], open: true, blankBefore: false };
  return b;
}
// Measure leading whitespace of `rest` (starting at column `col`).
// Returns { indent, rest, col, atEnd }.
function firstNonspace(rest, col) {
  let i = 0, c = col;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === ' ') { i++; c++; }
    else if (ch === '\t') { i++; c += 4 - (c % 4); }
    else break;
  }
  return { indent: c - col, rest: rest.slice(i), col: c, atEnd: i >= rest.length };
}
// Consume exactly `n` columns of indent from rest (starting at column `col`).
// A partially consumed tab is materialised as spaces. Returns { rest, col } or null.
function consumeIndent(rest, col, n) {
  let out = '', i = 0, c = col, rem = n;
  while (rem > 0) {
    if (i >= rest.length) return null;
    const ch = rest[i];
    if (ch === ' ') { i++; c++; rem--; }
    else if (ch === '\t') {
      const w = 4 - (c % 4);
      if (w <= rem) { i++; c += w; rem -= w; }
      else { out = ' '.repeat(w - rem); i++; c += rem; rem = 0; }
    } else return null;
  }
  return { rest: out + rest.slice(i), col: c };
}
// Remove UP TO `n` columns of leading indent from rest (starting at column `col`).
// A partially consumed tab is materialised as spaces. Never returns null.
function removeIndent(rest, col, n) {
  let out = '', i = 0, c = col, rem = n;
  while (rem > 0 && i < rest.length) {
    const ch = rest[i];
    if (ch === ' ') { i++; c++; rem--; }
    else if (ch === '\t') {
      const w = 4 - (c % 4);
      if (w <= rem) { i++; c += w; rem -= w; }
      else { out = ' '.repeat(w - rem); i++; c += rem; rem = 0; }
    } else break;
  }
  return { rest: out + rest.slice(i), col: c };
}

// Returns { rest, col } or null.
function matchBlockquote(rest, col) {
  const fn = firstNonspace(rest, col);
  if (fn.indent > 3 || fn.rest.charAt(0) !== '>') return null;
  // The whitespace after `>` is expanded with J (marked's
  // blockquoteMarkerWhitespace): tabs become spaces based on the column,
  // counting from the marker length (leading spaces + `>`).
  const markerLen = fn.indent + 1;
  const after = fn.rest.slice(1);
  let k = 0, t = markerLen, out = '';
  while (k < after.length && (after[k] === ' ' || after[k] === '\t')) {
    if (after[k] === ' ') { out += ' '; t++; k++; }
    else { const w = 4 - (t % 4); out += ' '.repeat(w); t += w; k++; }
  }
  // The first expanded space is the `>` separator; the rest is content.
  if (out.length > 0) out = out.slice(1);
  // Column of the first non-whitespace char in the original line: advance
  // past the marker and the original whitespace (tabs by their width).
  let c = fn.col + 1;
  for (let q = 0; q < k; q++) {
    if (after[q] === ' ') c++;
    else c += 4 - (c % 4);
  }
  return { rest: out + after.slice(k), col: c };
}
// Fence start: up to 3 spaces, then ``` or ~~~ (3+). Returns {char, len, info} or null.
function fenceStart(rest, col) {
  const fn = firstNonspace(rest, col);
  if (fn.indent > 3) return null;
  const m = /^(```+|~~~+)/.exec(fn.rest);
  if (!m) return null;
  const fence = m[0];
  if (fence.charAt(0) === '`' && fn.rest.slice(fence.length).includes('`')) return null;
  return { char: fence.charAt(0), len: fence.length, info: fn.rest.slice(fence.length), col: fn.col };
}
// Closing fence for a fenced block: up to 3 spaces, >= fenceLen of same char, only spaces after.
function isClosingFence(rest, col, char, len) {
  const fn = firstNonspace(rest, col);
  if (fn.indent > 3) return false;
  let i = 0;
  while (i < fn.rest.length && fn.rest[i] === char) i++;
  if (i < len) return false;
  return /^[ \t]*$/.test(fn.rest.slice(i));
}
// ATX heading: up to 3 spaces, 1-6 #, then space/tab/EOL. Returns {level, text} or null.
function atxHeading(rest, col) {
  const fn = firstNonspace(rest, col);
  if (fn.indent > 3) return null;
  const m = /^(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(fn.rest);
  if (!m) return null;
  let text = m[2] === undefined ? '' : m[2];
  // Strip trailing closing sequence of #s (preceded by space, or the whole text is #s).
  text = text.replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '');
  // Strip trailing whitespace.
  text = text.replace(/[ \t]+$/, '');
  return { level: m[1].length, text };
}
// Thematic break: up to 3 spaces, 3+ of -, _, * (same char), spaces/tabs between, nothing else.
function isThematicBreak(rest, col) {
  const fn = firstNonspace(rest, col);
  if (fn.indent > 3) return false;
  return /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(fn.rest);
}
// Setext underline: up to 3 spaces, only = (level 1) or - (level 2), spaces/tabs around.
function setextLevel(rest, col) {
  const fn = firstNonspace(rest, col);
  if (fn.indent > 3) return 0;
  if (/^=+[ \t]*$/.test(fn.rest)) return 1;
  if (/^-+[ \t]*$/.test(fn.rest)) return 2;
  return 0;
}
// HTML block start: returns type 1-7 or 0.
// Type 1: <script, <pre, <style, <textarea (followed by space/tab/>/EOL)
// Type 2: <!-- comment
// Type 3: <? processing instruction
// Type 4: <!A-Z declaration
// Type 5: <![CDATA[
// Type 6: < or </ + block tag (followed by space/tab/>/EOL)
// Type 7: < or </ + any tag name (not a block tag, not inline-only), complete open/close tag
function htmlBlockType(rest, col) {
  const fn = firstNonspace(rest, col);
  if (fn.indent > 3) return 0;
  const s = fn.rest;
  if (!s.startsWith('<')) return 0;
  let m;
  if ((m = /^<(script|pre|style|textarea)(?:[ \t>]|$)/i.exec(s))) return 1;
  if (s.startsWith('<!--')) return 2;
  if (s.startsWith('<?')) return 3;
  if (/^<![A-Za-z]/.test(s)) return 4;
  if (s.startsWith('<![CDATA[')) return 5;
  if ((m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t\/>]|$)/.exec(s))) {
    if (BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
    // Type 7: the whole line is a complete open tag (any tag name other than
    // the type-1 tags) or a closing tag.
    if (/^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>$/.test(s)) return 7;
    if (/^<(script|pre|style|textarea)(?:[ \t>]|$)/i.test(s)) return 0;
    if (/^<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][\w.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*[ \t]*\/?>[ \t]*$/.test(s)) return 7;
  }
  return 0;
}
// End condition for an HTML block of the given type, tested on a content line.
// Returns true if the block ends AFTER this line.
function htmlBlockEnds(type, line, tag) {
  if (type === 1) return new RegExp(`</${tag}>`, 'i').test(line);
  if (type === 2) return line.includes('-->');
  if (type === 3) return line.includes('?>');
  if (type === 4) return line.includes('>');
  if (type === 5) return line.includes(']]>');
  return false; // types 6 and 7 end at a blank line (handled by caller)
}
// List marker: up to 3 spaces, then a bullet or ordered marker followed by space/tab/EOL.
// Returns { marker, listType, start, delim, contentIndent, rest, col } or null.
// `rest`/`col` are the position just after the marker (before the following spaces).
function listMarker(rest, col) {
  const fn = firstNonspace(rest, col);
  if (fn.indent > 3) return null;
  const s = fn.rest;
  let m = /^([*+-])(?:[ \t]+|[ \t]*$)/.exec(s);
  let listType, start = null, delim = null, markerLen;
  if (m) {
    listType = 'bullet'; markerLen = 1;
  } else {
    m = /^(\d{1,9})([.)])(?:[ \t]+|[ \t]*$)/.exec(s);
    if (!m) return null;
    listType = 'ordered'; start = parseInt(m[1], 10); delim = m[2]; markerLen = m[0].length - (m[0].endsWith(' ') || m[0].endsWith('\t') ? 0 : 0);
    markerLen = m[1].length + 1;
  }
  const markerCol = fn.col;
  // Content indent: after the marker, 1-4 spaces of whitespace -> content starts
  // there; 5+ spaces -> content indent is marker width + 1 and the remaining
  // whitespace (as spaces) is part of the content.
  let r = s.slice(markerLen), c = markerCol + markerLen;
  let i = 0;
  while (i < r.length) {
    const ch = r[i];
    if (ch === ' ') { i++; c++; }
    else if (ch === '\t') { const w = 4 - (c % 4); i++; c += w; }
    else break;
  }
  const wsCols = c - (markerCol + markerLen);
  let contentIndent, contentRest, contentCol;
  if (i >= r.length) {
    // empty item
    contentIndent = markerCol + markerLen + 1;
    contentRest = ''; contentCol = c;
  } else if (wsCols >= 5) {
    contentIndent = markerCol + markerLen + 1;
    contentRest = ' '.repeat(c - contentIndent) + r.slice(i);
    contentCol = contentIndent;
  } else {
    contentIndent = c;
    contentRest = r.slice(i); contentCol = c;
  }
  return { listType, start, delim, marker: listType === 'bullet' ? s[0] : null, contentIndent, rest: contentRest, col: contentCol, markerCol };
}
// Table delimiter row: cells of - and optional :, separated by |.
// Returns { align: [...] } or null. `hasPipeOrColon` tells setext vs table apart.
function tableDelimiter(rest, col) {
  const fn = firstNonspace(rest, col);
  if (fn.indent > 3) return null;
  const s = fn.rest;
  if (!/^[:\- |]+$/.test(s)) return null;
  // Split into cells, ignoring a leading/trailing pipe.
  let cells = s.split('|');
  if (cells.length > 0 && cells[0].trim() === '') cells = cells.slice(1);
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells = cells.slice(0, -1);
  if (cells.length === 0) return null;
  const align = [];
  let hasPipe = s.includes('|'), hasColon = false;
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    if (t.includes(':')) hasColon = true;
    const left = t.startsWith(':'), right = t.endsWith(':');
    align.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return { align, hasPipe, hasColon };
}
// Split a table row into cells (marked's splitCells): unescaped | splits, \| kept.
function splitCells(row, count) {
  // Replace unescaped | with ' |' so the split on ' |' is unambiguous.
  let marked2 = '';
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '\\' && i + 1 < row.length) { marked2 += row[i] + row[i + 1]; i++; continue; }
    if (c === '|') marked2 += ' |';
    else marked2 += c;
  }
  let cells = marked2.split(' |');
  if (cells.length > 0 && cells[0].trim() === '') cells = cells.slice(1);
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells = cells.slice(0, -1);
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    while (cells.length < count) cells.push('');
  }
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'));
}

// ============================== block parser core ==============================
function parseBlocks(src) {
  // Split into lines; a trailing newline produces a spurious empty last
  // element (not a real line), drop it.
  const lines = src.split('\n');
  if (src.endsWith('\n')) lines.pop();
  const root = newBlock('document');
  const defs = new Map();
  const stack = [root];
  let prevBlank = false;
  let prevBlankDepth = 0;
  // Whether the preceding blank line was truly empty (no characters at all
  // after stripping container markers). A whitespace-only line (`   `)
  // does not suppress the trailing newline of a comment/PI/etc HTML block
  // (htmlType <= 5), though it does for type 6/7 blocks.
  let prevBlankEmpty = false;

  function finalize(b) {
    b.open = false;
    if (b.t === 'paragraph' && b.text === undefined) {
      // After a hard break (a line ending in 2+ spaces, or a trailing
      // backslash), the next line's leading whitespace is stripped.
      const lines = b.lines.slice();
      for (let k = 0; k + 1 < lines.length; k++) {
        const cur = lines[k];
        if (/ {2,}$/.test(cur) || /(^|[^\\])\\$/.test(cur)) {
          lines[k + 1] = lines[k + 1].replace(/^[ \t]+/, '');
        }
      }
      const text = lines.join('\n');
      const r = extractLinkDefs(text);
      for (const d of r.defs) if (!defs.has(d.label)) defs.set(d.label, { href: d.href, title: d.title });
      b.text = r.rest;
      b.empty = isBlankStr(r.rest);
    } else if (b.t === 'code' && b.text === undefined) {
      // Strip trailing blank lines. Fenced code keeps all but the last
      // blank line (the one before the closing fence); indented code
      // strips all trailing blank lines. Content ends with a newline.
      let end = b.lines.length;
      if (b.fenced) {
        if (end > 0 && b.lines[end - 1] === '') end--;
      } else {
        while (end > 0 && b.lines[end - 1] === '') end--;
      }
      const lines = b.lines.slice(0, end);
      b.text = lines.length === 0 ? '' : lines.join('\n') + '\n';
    } else if (b.t === 'html' && b.text === undefined) {
      b.text = b.lines.join('\n');
    } else if (b.t === 'list' && b.tight === undefined) {
      // A list is loose if any item (after the first) is preceded by a blank line,
      // or if any item contains two blocks separated by a blank line.
      let tight = true;
      for (let k = 0; k < b.children.length; k++) {
        const item = b.children[k];
        if (k > 0 && item.blankBefore) { tight = false; break; }
        for (let m = 1; m < item.children.length; m++) {
          if (item.children[m].blankBefore) { tight = false; break; }
        }
        if (!tight) break;
      }
      b.tight = tight;
    }
  }
  function closeBlocks(from) {
    for (let k = stack.length - 1; k >= from; k--) finalize(stack[k]);
    stack.length = from;
  }
  function addChild(parent, b) {
    // A preceding blank line counts only if it occurred at or above this
    // block's level (prevBlankDepth <= the stack depth where it is added).
    b.blankBefore = prevBlank && prevBlankDepth <= stack.length;
    b.blankBeforeEmpty = prevBlankEmpty && prevBlankDepth <= stack.length;
    b.parent = parent;
    parent.children.push(b);
    return b;
  }
  // A list can only contain items. If `c` is a list, close it and return its
  // parent so a non-item block is added at the right level.
  function ensureContainer(c) {
    if (c.t === 'list') {
      const si = stack.indexOf(c);
      if (si !== -1) closeBlocks(si);
      return c.parent || root;
    }
    return c;
  }
  // Convert the open paragraph `para` (tip) into a table when a delimiter row arrives.
  // `delim` is the parsed delimiter. Returns the new table block.
  function paragraphToTable(para, delim) {
    const text = para.lines.join('\n');
    const r = extractLinkDefs(text);
    for (const d of r.defs) if (!defs.has(d.label)) defs.set(d.label, { href: d.href, title: d.title });
    const restLines = r.rest === '' ? [] : r.rest.split('\n');
    const parent = para.parent;
    const idx = parent.children.indexOf(para);
    const header = restLines.length > 0 ? restLines[restLines.length - 1] : '';
    const before = restLines.slice(0, -1).join('\n');
    const table = newBlock('table');
    table.align = delim.align;
    table.header = splitCells(header, delim.align.length);
    table.rows = [];
    // Replace the paragraph in the parent with [paragraph?, table].
    const repl = [];
    if (before !== '' && !isBlankStr(before)) {
      const p = newBlock('paragraph');
      p.text = before;
      p.empty = false;
      p.blankBefore = para.blankBefore;
      p.blankBeforeEmpty = para.blankBeforeEmpty;
      p.parent = parent;
      repl.push(p);
    }
    table.blankBefore = repl.length > 0 ? false : para.blankBefore;
    table.blankBeforeEmpty = repl.length > 0 ? false : para.blankBeforeEmpty;
    table.parent = parent;
    repl.push(table);
    parent.children.splice(idx, 1, ...repl);
    // Remove the paragraph from the stack and push the table.
    const si = stack.indexOf(para);
    if (si !== -1) stack.splice(si, 1);
    stack.push(table);
    return table;
  }

  for (let li = 0; li < lines.length; li++) {
    const rawLine = lines[li];
    const blank = isBlankStr(rawLine);
    let rest = rawLine, col = 0;
    let lastContainer = root;
    let i = 1;
    let lineDone = false;

    // ---- Phase 1: match open blocks ----
    while (i < stack.length) {
      const b = stack[i];
      if (b.t === 'blockquote') {
        const m = matchBlockquote(rest, col);
        if (!m) break;
        rest = m.rest; col = m.col; lastContainer = b; i++;
      } else if (b.t === 'list') {
        lastContainer = b; i++;
      } else if (b.t === 'item') {
        if (blank || isBlankStr(rest)) { b.hadBlank = true; lastContainer = b; i++; }
        else {
          const fn = firstNonspace(rest, col);
          // The item's content indent is stored relative to the container
          // content start (so blockquote markers of different widths on
          // different lines do not break the match).
          if (fn.indent >= b.contentIndent) {
            const c = consumeIndent(rest, col, b.contentIndent);
            if (!c) break;
            rest = c.rest; col = c.col; lastContainer = b; i++;
          } else if (stack[stack.length - 1].t === 'code' && stack[stack.length - 1].fenced) {
            // Fenced code content does not need the item's indent.
            lastContainer = b; i++;
          } else break;
        }
      } else if (b.t === 'code' && b.fenced) {
        if (isClosingFence(rest, col, b.fenceChar, b.fenceLen)) {
          closeBlocks(i);
          lineDone = true;
          break;
        }
        // content line: dedent by the fence's indent (up to that many columns), then add.
        // Marked's indentCodeCompensation applies only to BACKTICK fences
        // (its regex matches leading whitespace followed by ```); a tilde
        // fence keeps the content's full indentation.
        const dedent = b.fenceChar === '`' ? b.fenceIndent : 0;
        const c = removeIndent(rest, col, dedent);
        let content = c.rest;
        // A leading tab expands to spaces for its width when the line's
        // indentation was consumed by a container (fenceIndent 0, col > 0);
        // when the fence dedent itself removed the spaces, or at the top
        // level, a leading tab stays a literal tab.
        if (content.charAt(0) === '\t' && b.fenceIndent === 0 && c.col > 0) {
          content = ' '.repeat(4 - (c.col % 4)) + content.slice(1);
        }
        b.lines.push(content);
        lineDone = true;
        break;
      } else if (b.t === 'code') {
        // indented code: blank or indented >= 4 (relative to current position).
        // A whitespace-only line keeps its spaces minus the 4-column indent.
        if (blank) {
          const c = removeIndent(rest, col, 4);
          b.lines.push(c ? c.rest : '');
          lineDone = true; break;
        }
        const fn = firstNonspace(rest, col);
        if (fn.indent >= 4) {
          const c = consumeIndent(rest, col, 4);
          b.lines.push(c ? c.rest : rest);
          lineDone = true;
          break;
        }
        break; // not indented enough -> code block ends
      } else if (b.t === 'html') {
        if (blank && (b.htmlType === 6 || b.htmlType === 7)) {
          closeBlocks(i);
          lineDone = false; // blank line continues to phase 2 (as a blank line)
          break;
        }
        b.lines.push(rest);
        if (b.htmlType <= 5 && htmlBlockEnds(b.htmlType, rest, b.htmlTag)) {
          closeBlocks(i);
        }
        lineDone = true;
        break;
      } else if (b.t === 'paragraph') {
        // Paragraph always matches here; interruption handled in phase 2.
        i++;
      } else if (b.t === 'table') {
        // A blank line ends the table, EXCEPT a whitespace-only line that
        // contains a tab: marked treats that as a body row of empty cells
        // (a tab is not "blank" for the table's row regex).
        if (blank && !rawLine.includes('\t')) { closeBlocks(i); lineDone = false; break; }
        // A line that starts a new block ends the table; otherwise it's a body row.
        // (Checked in phase 2 by seeing if the line starts a block; here we just note it
        // matches as a body row for now — phase 2 will close the table if a block starts.)
        i++;
      } else {
        break;
      }
    }
    if (lineDone) { prevBlank = blank; prevBlankDepth = blank ? 0 : stack.length; prevBlankEmpty = blank && rest === ''; continue; }
    // Phase 1 stopped at index i (first unmatched block). Do NOT close yet:
    // the line may be a lazy continuation of an open paragraph.
    const breakIdx = i;
    const phase1Len = stack.length;
    // If the line is blank after stripping container markers (e.g. `>`,
    // `>>`, `>  `, or a plain blank line), it is a blank line inside the
    // matched containers: close the blocks it is not inside, end an open
    // paragraph/leaf, and close an empty list item. No new block starts.
    if (isBlankStr(rest)) {
      // A whitespace-only line containing a tab, with an open table, is a
      // table body row of empty cells (not a blank line): fall through so
      // phase 2 adds it as a row.
      const tip0 = stack[stack.length - 1];
      if (tip0.t === 'table' && rest.includes('\t')) {
        // fall through to phase 2 (table body row)
      } else {
      // A whitespace-only line that still has spaces, with an open
      // paragraph, on the last line of the source, is paragraph content
      // (marked keeps a trailing spaces-only line inside the paragraph).
      const t0 = stack[stack.length - 1];
      if (rest.length > 0 && t0.t === 'paragraph' && li === lines.length - 1) {
        t0.lines.push(rest);
        t0.lastLazy = false;
        prevBlank = true;
        prevBlankDepth = stack.length;
        prevBlankEmpty = false;
        continue;
      }
      if (breakIdx < stack.length) closeBlocks(breakIdx);
      let t = stack[stack.length - 1];
      if (t.t === 'paragraph' || t.t === 'table' || (t.t === 'html' && (t.htmlType === 6 || t.htmlType === 7))) {
        closeBlocks(stack.length - 1);
      }
      t = stack[stack.length - 1];
      if (t.t === 'item' && t.children.length === 0) closeBlocks(stack.length - 1);
      // A blank line counts for a new block only if it occurred at or
      // above that block's level. A plain blank line counts everywhere
      // (depth 0). A line that became blank only after stripping container
      // markers (e.g. `  >` — an empty blockquote line inside a list item)
      // is blank only inside that container and must not make a sibling
      // item look blank-before. When the stack tip is still an item, the
      // blank separates that item from the next one, so the depth excludes
      // the item itself (otherwise a blank line between items in a
      // blockquote would never make the list loose).
      prevBlank = true;
      prevBlankDepth = blank ? 0 : (stack.length > 0 && stack[stack.length - 1].t === 'item' ? stack.length - 1 : stack.length);
      prevBlankEmpty = rest === '';
      continue;
      }
    }
    // Last matched container: deepest container at index < breakIdx.
    let tip = stack[stack.length - 1];
    lastContainer = root;
    for (let k = breakIdx - 1; k >= 1; k--) {
      const b = stack[k];
      if (b.t === 'blockquote' || b.t === 'list' || b.t === 'item') { lastContainer = b; break; }
    }
    // A line is a lazy-continuation candidate when some container did not
    // match and the tip is a paragraph.
    const isLazy = breakIdx < stack.length && tip.t === 'paragraph' && !blank;
    // Close the phase-1 unmatched blocks [breakIdx, phase1Len) (once) when a
    // new block starts. Blocks created in phase 2 (at index >= phase1Len)
    // are NOT closed.
    let unmatchedClosed = false;
    function closeUnmatched() {
      if (!unmatchedClosed && breakIdx < phase1Len) {
        for (let k = phase1Len - 1; k >= breakIdx; k--) finalize(stack[k]);
        stack.splice(breakIdx, phase1Len - breakIdx);
        unmatchedClosed = true;
      }
    }
    // Close unmatched blocks and, if the tip is still a leaf, close it too
    // (a new block interrupts it).
    function closeForNewBlock() {
      closeUnmatched();
      const t = stack[stack.length - 1];
      if (t.t === 'paragraph' || t.t === 'code' || t.t === 'html' || t.t === 'table') {
        closeBlocks(stack.length - 1);
      }
      // Re-point `cur` at the deepest container still open (the closed
      // blocks' parent), so the new block is added at the right level
      // (e.g. a lazy list marker ends the blockquote and starts a list
      // outside it, not inside it).
      cur = root;
      for (let k = stack.length - 1; k >= 1; k--) {
        const b = stack[k];
        if (b.t === 'blockquote' || b.t === 'list' || b.t === 'item') { cur = b; break; }
      }
    }

    // ---- Phase 2: start new blocks / add content (loop for nested containers) ----
    let cur = lastContainer;
    let curRest = rest, curCol = col;
    for (;;) {
      tip = stack[stack.length - 1];
      const leaf = (tip.t === 'paragraph' || tip.t === 'code' || tip.t === 'html' || tip.t === 'table') ? tip : null;
      const fn = firstNonspace(curRest, curCol);
      const indent = fn.indent;

      // Table delimiter / setext: a lazy-continuation line cannot be a
      // setext underline or a table delimiter row.
      if (!isLazy) {
        // Table delimiter: convert an open paragraph into a table.
        if (leaf && leaf.t === 'paragraph') {
          const td = tableDelimiter(curRest, curCol);
          // The delimiter must have the same number of columns as the
          // header row (the paragraph's last line); otherwise it is not
          // a table at all.
          let colMatch = false;
          if (td && (td.hasPipe || td.hasColon) && leaf.lines.length > 0) {
            const headerCells = splitCells(leaf.lines[leaf.lines.length - 1]);
            colMatch = headerCells.length === td.align.length;
          }
          if (td && (td.hasPipe || td.hasColon) && colMatch) {
            const table = paragraphToTable(leaf, td);
            // The delimiter line is consumed; the table is now the tip.
            cur = table.parent || root;
            break;
          }
        }
        // Setext heading: convert an open paragraph (only if it has content
        // after link definitions are removed; an empty paragraph is not a heading).
        if (leaf && leaf.t === 'paragraph') {
          const sl = setextLevel(curRest, curCol);
          if (sl > 0) {
            const text = leaf.lines.join('\n');
            const r = extractLinkDefs(text);
            if (!isBlankStr(r.rest)) {
              for (const d of r.defs) if (!defs.has(d.label)) defs.set(d.label, { href: d.href, title: d.title });
              const h = newBlock('heading');
              h.level = sl;
              h.text = r.rest.replace(/^[ \t]+|[ \t]+$/g, '');
              h.blankBefore = leaf.blankBefore;
              h.parent = leaf.parent;
              const parent = leaf.parent;
              const idx = parent.children.indexOf(leaf);
              parent.children.splice(idx, 1, h);
              const si = stack.indexOf(leaf);
              if (si !== -1) stack.splice(si, 1);
              break;
            }
            // Empty paragraph: the underline is ordinary paragraph text.
            // Fall through to the paragraph branch below.
          }
        }
      }
      // Fenced code (can interrupt a paragraph).
      const fs = fenceStart(curRest, curCol);
      if (fs) {
        closeForNewBlock();
        const cb = newBlock('code');
        cb.fenced = true; cb.fenceChar = fs.char; cb.fenceLen = fs.len;
        cb.info = fs.info.trim();
        // Language is the first word of the info string, backslash escapes decoded.
        const firstWord = cb.info.split(/[ \t]/)[0] || '';
        cb.lang = firstWord.replace(/\\([!-\\/:-@\[-`{-~])/g, '$1');
        cb.fenceIndent = fs.col - curCol;
        cb.lines = [];
        cur = ensureContainer(cur);
        addChild(cur, cb);
        stack.push(cb);
        break;
      }
      // ATX heading (can interrupt a paragraph).
      const ah = atxHeading(curRest, curCol);
      if (ah) {
        closeForNewBlock();
        const h = newBlock('heading');
        h.level = ah.level; h.text = ah.text;
        cur = ensureContainer(cur);
        addChild(cur, h);
        break;
      }
      // HTML block types 1-6 (can interrupt a paragraph); type 7 cannot.
      const ht = htmlBlockType(curRest, curCol);
      if (ht > 0 && (ht <= 6 || !leaf || leaf.t !== 'paragraph')) {
        closeForNewBlock();
        const hb = newBlock('html');
        hb.htmlType = ht; hb.lines = [curRest];
        const mtag = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(curRest.trimStart());
        hb.htmlTag = mtag ? mtag[1].toLowerCase() : '';
        cur = ensureContainer(cur);
        addChild(cur, hb);
        stack.push(hb);
        if (ht <= 5 && htmlBlockEnds(ht, curRest, hb.htmlTag)) {
          closeBlocks(stack.length - 1);
        }
        break;
      }
      // Thematic break (can interrupt a paragraph).
      if (isThematicBreak(curRest, curCol)) {
        closeForNewBlock();
        cur = ensureContainer(cur);
        addChild(cur, newBlock('thematic_break'));
        break;
      }
      // List item. If we are CONTINUING an already-open list of the same
      // kind, an empty item is fine. A list marker at the list's own level
      // always starts a new item (or a new list when the delimiter differs),
      // even inside a list-item paragraph. Otherwise a list item can
      // interrupt a paragraph only if it is non-empty (or ordered starting at 1).
      const lm = listMarker(curRest, curCol);
      if (lm) {
        const isContinuation = cur.t === 'list' && (
          (cur.listType === 'bullet' && lm.listType === 'bullet' && cur.marker === lm.marker) ||
          (cur.listType === 'ordered' && lm.listType === 'ordered' && cur.delim === lm.delim)
        );
        // An ordered list may interrupt a paragraph only when it starts at
        // 1 -- unless the paragraph is inside a list item, where a nested
        // list may start at any number.
        let insideItem = false;
        if (leaf && leaf.t === 'paragraph') {
          let anc = leaf.parent;
          while (anc) {
            if (anc.t === 'item') { insideItem = true; break; }
            anc = anc.parent;
          }
        }
        const canInterrupt = isContinuation || cur.t === 'list' || !leaf || leaf.t !== 'paragraph' ||
          (lm.listType === 'bullet' && lm.rest.trim() !== '') ||
          (lm.listType === 'ordered' && lm.rest.trim() !== '' && (insideItem || lm.start === 1));
        if (canInterrupt) {
          closeForNewBlock();
          // Find or create the list. If `cur` itself is an open list of the
          // same kind, the item belongs to it. A non-matching list cannot
          // contain a list directly, so close it and use its parent.
          const listMatches = (l) => l.listType === lm.listType &&
            (lm.listType === 'bullet' ? l.marker === lm.marker : l.delim === lm.delim);
          let list = null;
          if (cur.t === 'list' && cur.open && listMatches(cur)) {
            list = cur;
          } else {
            if (cur.t === 'list') {
              const si = stack.indexOf(cur);
              if (si !== -1) closeBlocks(si);
              cur = cur.parent || root;
            }
            const kids = cur.children;
            if (kids.length > 0) {
              const last = kids[kids.length - 1];
              if (last.t === 'list' && last.open && listMatches(last)) list = last;
            }
          }
          if (!list) {
            list = newBlock('list');
            list.listType = lm.listType; list.start = lm.start; list.delim = lm.delim;
            list.marker = lm.marker;
            addChild(cur, list);
            stack.push(list);
          }
          const item = newBlock('item');
          // Store the content indent RELATIVE to the start of the line's
          // content (curCol), so matching a later line does not depend on
          // the absolute column (blockquote markers may be wider/narrower
          // on other lines).
          item.contentIndent = lm.contentIndent - curCol;
          item.blankBefore = prevBlank && prevBlankDepth <= stack.length;
          item.parent = list;
          list.children.push(item);
          stack.push(item);
          cur = item;
          curRest = lm.rest; curCol = lm.col;
          if (isBlankStr(curRest)) break; // empty item; line done
          continue; // try to start a block inside the item
        }
      }
      // Blockquote (can interrupt a paragraph? A blockquote CAN interrupt a paragraph).
      const bq = matchBlockquote(curRest, curCol);
      if (bq) {
        closeForNewBlock();
        cur = ensureContainer(cur);
        let b = null;
        const kids = cur.children;
        if (kids.length > 0) {
          const last = kids[kids.length - 1];
          if (last.t === 'blockquote' && last.open) b = last;
        }
        if (!b) {
          b = newBlock('blockquote');
          addChild(cur, b);
          stack.push(b);
        }
        cur = b;
        curRest = bq.rest; curCol = bq.col;
        if (isBlankStr(curRest)) break;
        continue;
      }
      // Indented code (cannot interrupt a paragraph). A whitespace-only
      // line is not indented code (it is blank, or a table body row).
      if ((!leaf || leaf.t !== 'paragraph') && indent >= 4 && !isBlankStr(curRest)) {
        const c = consumeIndent(curRest, curCol, 4);
        const cb = newBlock('code');
        cb.fenced = false; cb.lines = [c ? c.rest : curRest];
        cur = ensureContainer(cur);
        addChild(cur, cb);
        stack.push(cb);
        break;
      }
      // Otherwise: add to an open paragraph, or start a new paragraph.
      // Leading spaces are part of the paragraph content (only headings strip them).
      if (leaf && leaf.t === 'paragraph') {
        let line = curRest;
        if (isLazy) {
          // Lazy continuation line (marked's blockquote extraction):
          // - a setext-looking line after another lazy line gets 4 spaces
          //   (so it is not re-read as a setext underline);
          // - otherwise, if the line is indented >= 4 columns, strip 4
          //   columns; lesser indentation is preserved as-is.
          const fn = firstNonspace(curRest, curCol);
          const isSetext = /^(=+|-+)[ \t]*$/.test(fn.rest);
          if (isSetext && leaf.lastLazy) {
            if (fn.indent <= 3) line = '    ' + fn.rest;
          } else if (fn.indent >= 4) {
            line = removeIndent(curRest, curCol, 4).rest;
          }
        }
        leaf.lines.push(line);
        leaf.lastLazy = isLazy;
        break;
      }
      if (leaf && leaf.t === 'table') {
        // A line that is not a new block is a body row.
        leaf.rows.push(splitCells(curRest, leaf.align.length));
        break;
      }
      const p = newBlock('paragraph');
      p.lines = [curRest];
      closeForNewBlock();
      cur = ensureContainer(cur);
      addChild(cur, p);
      stack.push(p);
      break;
    }
    prevBlank = blank;
    prevBlankDepth = blank ? 0 : stack.length;
    prevBlankEmpty = false;
  }
  closeBlocks(1);
  return { root, defs };
}

// ============================== inline parsing ==============================
const PUNCT_RE = /[\p{P}\p{S}]/u;
const WS_RE = /\s/;
function isWS(c) { return c === undefined || WS_RE.test(c); }
function isPunctCh(c) { return c !== undefined && PUNCT_RE.test(c); }
// Flanking for a delimiter run: `before`/`after` are adjacent chars (undefined at edges).
function flanking(before, after) {
  const left = !isWS(after) && (!isPunctCh(after) || isWS(before) || isPunctCh(before));
  const right = !isWS(before) && (!isPunctCh(before) || isWS(after) || isPunctCh(after));
  return { left, right };
}
// Match a bare URL / www / email starting at index `i` in `s`.
// Returns { url, end, kind: 'url'|'email' } or null. `prev` is the char before `i`.
const BARE_URL_RE = /^(?:(?:[Hh][Tt][Tt][Pp][Ss]?|[Ff][Tt][Pp]):\/\/|www\.)(?:[A-Za-z0-9\-]+\.?)+[^\s<]*/;
const EMAIL_RE = /^[A-Za-z0-9._+\-]+@[a-zA-Z0-9\-_]+(?:\.[a-zA-Z0-9\-_]*[a-zA-Z0-9])+(?![\w\-])/;
// Same as EMAIL_RE but without the trailing lookahead: used to recover the
// full domain when the lookahead made the regex backtrack to a shorter
// match (e.g. an email inside `__...__`, where the closing `__` follows).
const EMAIL_RE_FULL = /^[A-Za-z0-9._+\-]+@[a-zA-Z0-9\-_]+(?:\.[a-zA-Z0-9\-_]*[a-zA-Z0-9])+/;
const EMAIL_PREV_RE = /[A-Za-z0-9._+\-]/;
// Marked's GFM `_backpedal` regex (applied repeatedly until stable): a
// `)` is kept when it belongs to a balanced `(...)` group; a trailing
// `&word;` (entity-like) is trimmed entirely.
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function backpedalUrl(url) {
  let cur = url;
  for (;;) {
    const m = BACKPEDAL_RE.exec(cur);
    const next = m ? m[0] : '';
    if (next === cur) return cur;
    cur = next;
  }
}
function matchBareAutolink(s, i) {
  const prev = i > 0 ? s[i - 1] : undefined;
  const sub = s.slice(i);
  // mailto: / xmpp: + email (the scheme is part of the autolink).
  // xmpp may carry one /resource segment.
  const sm = /^(?:mailto|xmpp):/.exec(sub);
  if (sm) {
    if (prev === undefined || !EMAIL_PREV_RE.test(prev)) {
      const em2 = EMAIL_RE.exec(sub.slice(sm[0].length));
      if (em2) {
        let url = sm[0] + em2[0];
        let end = i + url.length;
        if (sm[0] === 'xmpp:') {
          const rm = /^\/[A-Za-z0-9@.]+/.exec(sub.slice(url.length));
          if (rm) { url += rm[0]; end += rm[0].length; }
        }
        return { url, end, kind: 'url' };
      }
    }
  }
  const um = BARE_URL_RE.exec(sub);
  if (um) {
    const isWww = /^www\./i.test(um[0]);
    if (isWww) {
      // www. needs a start/whitespace/*_~( before it.
      if (prev !== undefined && !(isWS(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(')) return null;
    }
    const url = backpedalUrl(um[0]);
    if (url.length === 0) return null;
    return { url, end: i + url.length, kind: 'url' };
  }
  const em = EMAIL_RE.exec(sub);
  if (em) {
    if (prev !== undefined && EMAIL_PREV_RE.test(prev)) return null;
    return { url: em[0], end: i + em[0].length, kind: 'email' };
  }
  return null;
}
// Autolink <scheme:...> or <email>. Returns { href, text, end } or null.
const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.\-]{1,31}:[^\s\x00-\x1f<>]*)>/;
const EMAIL_ANGLE_RE = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
function matchAngleAutolink(s, i) {
  const sub = s.slice(i);
  let m = AUTOLINK_RE.exec(sub);
  if (m) return { href: m[1], text: m[1], end: i + m[0].length, email: false };
  if (sub[1] === '>') return null;
  m = /^<([^<>]*)>/.exec(sub);
  if (m && EMAIL_ANGLE_RE.test(m[1])) return { href: 'mailto:' + m[1], text: m[1], end: i + m[0].length, email: true };
  return null;
}
// Inline HTML tag: open/close tag, comment, processing instruction, declaration, CDATA.
// Returns the matched tag string or null.
const INLINE_TAG_RE = /^<!--(?:-?>|[\s\S]*?(?:-->|$))|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
// Code span: find a matching run of backticks.
function matchCodeSpan(s, i) {
  let n = 0;
  while (s[i + n] === '`') n++;
  let from = i + n;
  for (;;) {
    const p = s.indexOf('`'.repeat(n), from);
    if (p === -1) return null;
    // A closing run must be exactly n backticks: not preceded or followed
    // by another backtick (else it is part of a longer run).
    if (s[p - 1] !== '`' && s[p + n] !== '`') {
      return { content: s.slice(i + n, p), end: p + n };
    }
    from = p + 1;
  }
}
function processCodeSpanContent(content) {
  // Newlines become spaces; strip one leading/trailing space if both present
  // and the content is not all spaces.
  let c = content.replace(/\n/g, ' ');
  if (c.length >= 2 && c[0] === ' ' && c[c.length - 1] === ' ' && /[^ ]/.test(c)) c = c.slice(1, -1);
  return c;
}
// Plain text of inline nodes (for image alt): formatting stripped.
function plainText(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.s;
    else if (n.t === 'code') out += n.s;
    else if (n.t === 'em' || n.t === 'strong' || n.t === 'del' || n.t === 'link') out += plainText(n.children);
    else if (n.t === 'image') out += n.alt;
    else if (n.t === 'br') out += '\n';
    else if (n.t === 'softbr') out += '\n';
    // html and delim contribute nothing
  }
  return out;
}
// Document-level inLink state: an opening `<a ...>` inline tag sets it and a
// closing `</a>` clears it; it persists across blocks (marked's inline lexer
// keeps one instance per document), gating bare-URL/email autolinks.
let docInLink = false;

// Parse inline content `text` into nodes. `defs` is the link-reference map.
// `inLink` gates bare-URL/email autolinks.
function parseInline(text, defs, inLink) {
  const effInLink = inLink || docInLink;
  const nodes = [];
  const n = text.length;
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf !== '') { nodes.push({ t: 'text', s: escapeText(buf) }); buf = ''; }
  };
  const pushNode = (nd) => { flush(); nodes.push(nd); };

  while (i < n) {
    const c = text[i];
    // Backslash escape / hard break. Only ASCII punctuation can be escaped;
    // a backslash-escaped & must not be re-read as an entity reference.
    if (c === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') { pushNode({ t: 'br' }); i += 2; continue; }
      if (nx !== undefined && isPunct(nx)) {
        if (nx === '&') { pushNode({ t: 'text', s: '&amp;' }); i += 2; continue; }
        buf += nx; i += 2; continue;
      }
      buf += c; i++; continue;
    }
    // Code span.
    if (c === '`') {
      const cs = matchCodeSpan(text, i);
      if (cs) {
        pushNode({ t: 'code', s: escapeAll(processCodeSpanContent(cs.content)) });
        i = cs.end; continue;
      }
      // No matching closing run: the whole backtick run is literal text
      // (do not retry from inside the run).
      let n = 0;
      while (text[i + n] === '`') n++;
      buf += '`'.repeat(n); i += n; continue;
    }
    // < autolink / inline HTML.
    if (c === '<') {
      const al = matchAngleAutolink(text, i);
      if (al) {
        const href = cleanUrl(al.href);
        if (href !== null) {
          pushNode({ t: 'link', href: escapeText(href), title: null, auto: true, children: [{ t: 'text', s: escapeText(al.text) }] });
        } else {
          buf += text.slice(i, al.end);
        }
        i = al.end; continue;
      }
      const tm = INLINE_TAG_RE.exec(text.slice(i));
      if (tm) {
        if (!inLink) {
          const tag = tm[0];
          if (/^<a(?:[\s/>]|$)/i.test(tag)) docInLink = true;
          else if (/^<\/a(?:[\s>]|$)/i.test(tag)) docInLink = false;
        }
        pushNode({ t: 'html', s: tm[0] }); i += tm[0].length; continue;
      }
      buf += c; i++; continue;
    }
    // Link / image.
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      const lk = parseLink(text, i, defs, effInLink);
      if (lk) { pushNode(lk.node); i = lk.end; continue; }
      buf += c; i++; continue;
    }
    // Delimiter run (*, _, ~).
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (text[j] === c) j++;
      const len = j - i;
      const before = i > 0 ? text[i - 1] : undefined;
      const after = j < n ? text[j] : undefined;
      const { left, right } = flanking(before, after);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = left && (!right || isPunctCh(before));
        canClose = right && (!left || isPunctCh(after));
      } else {
        canOpen = left; canClose = right;
      }
      // A `~` run of 3+ is not a strikethrough delimiter at all (marked's
      // del regex matches only 1-2 tildes, and the lookahead fails when a
      // third tilde follows).
      if (c === '~' && len > 2) { canOpen = false; canClose = false; }
      pushNode({ t: 'delim', char: c, len, canOpen, canClose });
      i = j; continue;
    }
    // Entity / numeric reference.
    if (c === '&') {
      const nm = /^&#(?:(\d{1,7})|[Xx]([0-9A-Fa-f]{1,6}));/.exec(text.slice(i));
      if (nm) {
        const dec = decodeNumericRef(nm[1] !== undefined ? nm[1] : 'x' + nm[2]);
        if (dec !== null) {
          pushNode({ t: 'text', s: escapeAll(dec) });
          i += nm[0].length; continue;
        }
      }
      const en = /^&\w+;/.exec(text.slice(i));
      if (en) { pushNode({ t: 'text', s: en[0] }); i += en[0].length; continue; }
      buf += c; i++; continue;
    }
    // Line break.
    if (c === '\n') {
      const m = / {2,}$/.exec(buf);
      if (m) { buf = buf.slice(0, buf.length - m[0].length); pushNode({ t: 'br' }); }
      else pushNode({ t: 'softbr' });
      i++; continue;
    }
    // Bare GFM autolink (gated by inLink).
    if (!effInLink) {
      let ba = matchBareAutolink(text, i);
      // An email inside `__...__` (or `**...**`): the closing delimiter
      // follows the domain, and EMAIL_RE's `(?![\w\-])` lookahead makes it
      // backtrack to a shorter domain (`table@nimbus.example` instead of
      // `table@nimbus.example.com`). If an unmatched opener of the same
      // delimiter is already in `nodes`, the trailing run is an emphasis
      // closer, so recover the full domain with the lookahead-free regex.
      if (ba && ba.kind === 'email') {
        // The truncated match ends before the remaining domain part
        // (`.com`), so check the text after the FULL domain instead.
        const full = EMAIL_RE_FULL.exec(text.slice(i));
        if (full && full[0].length > ba.url.length) {
          const afterFull = text.slice(i + full[0].length);
          const dm = /^(_+|\*+)/.exec(afterFull);
          if (dm) {
            const dch = dm[1][0];
            let hasOpener = false;
            for (let q = nodes.length - 1; q >= 0; q--) {
              const nd = nodes[q];
              if (nd.t === 'delim' && nd.char === dch && nd.len >= 1 && nd.canOpen) { hasOpener = true; break; }
            }
            if (hasOpener) {
              ba = { url: full[0], end: i + full[0].length, kind: 'email' };
            }
          }
        }
      }
      if (ba) {
        if (ba.kind === 'url') {
          const href = cleanUrl(ba.url.startsWith('www.') ? 'http://' + ba.url : ba.url);
          if (href !== null) {
            pushNode({ t: 'link', href: escapeText(href), title: null, auto: true, children: [{ t: 'text', s: escapeText(ba.url) }] });
            i = ba.end; continue;
          }
        } else {
          pushNode({ t: 'link', href: escapeText('mailto:' + ba.url), title: null, auto: true, children: [{ t: 'text', s: escapeText(ba.url) }] });
          i = ba.end; continue;
        }
      }
    }
    buf += c; i++;
  }
  flush();
  processEmphasis(nodes);
  return nodes;
}
// Try to parse a link/image starting at `i` in `text` (text[i] is '[' or '!').
// Returns { node, end } or null.
function parseLink(text, i, defs, inLink) {
  let isImage = false;
  let j = i;
  if (text[j] === '!') { isImage = true; j++; }
  if (text[j] !== '[') return null;
  const close = findCloseBracket(text, j);
  if (close === -1) return null;
  const label = text.slice(j + 1, close - 1);
  let k = close;
  if (text[k] === '(') {
    // Try an inline link. If it fails to parse, fall through to the
    // reference-link handling below (a shortcut reference may still match).
    let m = skipSpaceNewline(text, k + 1);
    let href = '', title = null;
    if (text[m] === ')') {
      const node = makeLinkOrImage(isImage, '', null, label, defs);
      if (node) return { node, end: m + 1 };
    } else {
      const d = parseDest(text, m);
      if (d) {
        href = d.dest;
        m = d.end;
        const save = m;
        m = skipSpaceNewline(text, m);
        const t = parseTitle(text, m);
        if (t) { title = t.title; m = t.end; } else { m = save; }
        m = skipSpaceNewline(text, m);
        if (text[m] === ')') {
          const node = makeLinkOrImage(isImage, href, title, label, defs);
          if (node) return { node, end: m + 1 };
        }
      }
    }
  }
  let refLabel;
  if (text[k] === '[') {
    const close2 = findCloseBracket(text, k);
    if (close2 === -1) return null;
    refLabel = text.slice(k + 1, close2 - 1);
    // Collapsed reference [label][] uses the label itself as the reference.
    if (refLabel === '') refLabel = label;
    if (!isValidRefLabel(refLabel)) return null;
    k = close2;
  } else {
    refLabel = label;
    if (!isValidRefLabel(refLabel)) return null;
  }
  const def = defs.get(normalizeLabel(refLabel));
  if (!def) return null;
  const node = makeLinkOrImage(isImage, def.href, def.title, label, defs);
  if (!node) return null;
  return { node, end: k };
}
function makeLinkOrImage(isImage, href, title, label, defs) {
  const children = parseInline(label, defs, true);
  if (!isImage) {
    // A link's text must not contain another (non-autolink) link anywhere
    // in its subtree, not just among its direct children.
    const hasLink = (nodes) => {
      for (const c of nodes) {
        if (c.t === 'link' && !c.auto) return true;
        if (c.children && hasLink(c.children)) return true;
      }
      return false;
    };
    if (hasLink(children)) return null;
    const clean = cleanUrl(href);
    if (clean === null) return null;
    return { t: 'link', href: escapeText(clean), title: title === null ? null : escapeText(title), children };
  }
  const alt = escapeText(plainText(children));
  const clean = cleanUrl(href);
  if (clean === null) return null;
  return { t: 'image', href: escapeText(clean), title: title === null ? null : escapeText(title), alt };
}
// Resolve emphasis / strong / strikethrough in a node list (delimiter-stack algorithm).
function processEmphasis(nodes) {
  const openers = []; // stack of delim nodes that can open
  let idx = 0;
  while (idx < nodes.length) {
    const cur = nodes[idx];
    if (cur.t !== 'delim') { idx++; continue; }
    if (cur.canClose) {
      // Try to match this closer against openers (nearest first). A closer with
      // leftover length retries against earlier openers.
      let matchedOnce = false;
      let lastEmNode = null;
      while (cur.len > 0) {
        let opener = null;
        let oi = -1;
        for (let s = openers.length - 1; s >= 0; s--) {
          const cand = openers[s];
          if (cand.char !== cur.char) continue;
          // Rule of 3: if either can both open and close, the sum must not be a
          // multiple of 3 unless both lengths are multiples of 3.
          if ((cand.canClose || cur.canOpen) &&
              (cand.len + cur.len) % 3 === 0 &&
              !(cand.len % 3 === 0 && cur.len % 3 === 0)) continue; // blocked; try earlier
          // A single `*` closer must not steal one asterisk from an exactly
          // `**` opener when a later `**` closer could form the strong AND
          // the closer is attached to a preceding em/strong (the word right
          // before it directly follows an em/strong node with no space).
          // Marked: `**a *b*c* d**` and `**public as *so*other* option html**`
          // keep the single `*` literal so the trailing `**` forms the
          // strong; but `**a *b* c* d**` (space before the word) matches.
          if (cur.char === '*' && cand.len === 2 && cur.len === 1) {
            const cPos3 = nodes.indexOf(cur);
            let laterDouble = false;
            for (let q = cPos3 + 1; q < nodes.length; q++) {
              const nd = nodes[q];
              if (nd.t === 'delim' && nd.char === '*' && nd.len >= 2 && nd.canClose) { laterDouble = true; break; }
            }
            if (laterDouble) {
              const pv = nodes[cPos3 - 1];
              const pv2 = nodes[cPos3 - 2];
              const attached = !!pv && pv.t === 'text' && pv.s !== '' && !isWS(pv.s[0]) &&
                !!pv2 && (pv2.t === 'em' || pv2.t === 'strong');
              if (attached) continue; // try an earlier opener
            }
          }
          // A single `*` emphasis must not span a `**` strong whose opening
          // delimiter was preceded by whitespace and whose closing delimiter
          // is followed by a word character (marked leaves `*a **b**c*`
          // literal, but allows `*foo**bar**baz*`, `*foo **bar***`,
          // `*(**foo**)*`, and `*a **b** c*`). This applies whenever the
          // opener is a single `*` (use will be 1), whatever the closer's
          // length — e.g. `**removes example *input **parse**parse* release**`
          // must not let the `*` before `input` match the trailing `**`.
          if (cur.char === '*' && cand.len === 1) {
            const oPos2 = nodes.indexOf(cand);
            const cPos2 = nodes.indexOf(cur);
            const inner2 = nodes.slice(oPos2 + 1, cPos2);
            let blocked = false;
            for (let q = 0; q < inner2.length; q++) {
              if (inner2[q].t === 'strong') {
                const pv = inner2[q - 1];
                const nx = inner2[q + 1];
                const beforeWS = !!pv && pv.t === 'text' && pv.s !== '' && isWS(pv.s[pv.s.length - 1]);
                const afterWord = !!nx && nx.t === 'text' && nx.s !== '' && !isWS(nx.s[0]) && !isPunctCh(nx.s[0]);
                if (beforeWS && afterWord) { blocked = true; break; }
              }
            }
            if (blocked) continue; // try an earlier opener
          }
          opener = cand; oi = s; break;
        }
        if (!opener) break;
        // Determine use: 2 for strong/del (if both have >= 2), else 1 for em/del.
        // A single `~` is also a valid strikethrough delimiter (marked's del
        // regex is `~~?`).
        const use = (opener.len >= 2 && cur.len >= 2) ? 2 : 1;
        const type = cur.char === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        const oPos = nodes.indexOf(opener);
        const cPos = nodes.indexOf(cur);
        const inner = nodes.slice(oPos + 1, cPos);
        opener.len -= use;
        cur.len -= use;
        const emNode = { t: type, children: inner };
        lastEmNode = emNode;
        const repl = [];
        if (opener.len > 0) repl.push(opener);
        repl.push(emNode);
        if (cur.len > 0) repl.push(cur);
        nodes.splice(oPos, cPos - oPos + 1, ...repl);
        // Remove from the opener stack any opener now inside the new node,
        // and the opener itself if exhausted.
        for (let s = openers.length - 1; s >= 0; s--) {
          const o = openers[s];
          if (o === opener && opener.len === 0) { openers.splice(s, 1); continue; }
          if (inner.includes(o)) openers.splice(s, 1);
        }
        matchedOnce = true;
        // If the closer still has length, loop to match an earlier opener.
      }
      if (matchedOnce) {
        if (cur.len === 0) {
          // Continue scanning after the last em node created.
          idx = nodes.indexOf(lastEmNode) + 1;
        } else {
          // Closer remains; if it can open, it becomes an opener.
          if (cur.canOpen && !openers.includes(cur)) openers.push(cur);
          idx = nodes.indexOf(cur) + 1;
        }
        continue;
      }
      // No match: if it can also open, push it as an opener.
      if (cur.canOpen) { openers.push(cur); idx++; continue; }
      idx++; continue;
    }
    if (cur.canOpen) { openers.push(cur); }
    idx++;
  }
  // Remaining delimiters become literal text.
  for (let k = 0; k < nodes.length; k++) {
    if (nodes[k].t === 'delim') nodes[k] = { t: 'text', s: nodes[k].char.repeat(nodes[k].len) };
  }
}
// Render inline nodes to HTML.
function renderInline(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.s;
    else if (n.t === 'code') out += '<code>' + n.s + '</code>';
    else if (n.t === 'html') out += n.s;
    else if (n.t === 'br') out += '<br>';
    else if (n.t === 'softbr') out += '\n';
    else if (n.t === 'em') out += '<em>' + renderInline(n.children) + '</em>';
    else if (n.t === 'strong') out += '<strong>' + renderInline(n.children) + '</strong>';
    else if (n.t === 'del') out += '<del>' + renderInline(n.children) + '</del>';
    else if (n.t === 'link') out += '<a href="' + n.href + '"' + (n.title !== null ? ' title="' + n.title + '"' : '') + '>' + renderInline(n.children) + '</a>';
    else if (n.t === 'image') out += '<img src="' + n.href + '" alt="' + n.alt + '"' + (n.title !== null ? ' title="' + n.title + '"' : '') + '>';
    else if (n.t === 'delim') out += n.char.repeat(n.len);
  }
  return out;
}

// ============================== block rendering ==============================
// `lastTrailNL`: whether an HTML block that is the last block of this list
// should get a trailing newline (true unless the source ends with a blank line
// or without a newline).
function renderBlocks(blocks, defs, lastTrailNL) {
  let out = '';
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    // Trailing-newline decision for this block (and for the children of a
    // container block): no newline if the next block is preceded by a blank
    // line; otherwise use the parent's decision. For comment/PI/etc HTML
    // blocks (htmlType <= 5), only a truly empty blank line suppresses the
    // newline; a whitespace-only line does not.
    let nextBlank = false;
    if (k < blocks.length - 1) {
      const nb = blocks[k + 1];
      nextBlank = (b.t === 'html' && b.htmlType !== undefined && b.htmlType <= 5) ? nb.blankBeforeEmpty : nb.blankBefore;
    }
    const childTrailNL = (k < blocks.length - 1) ? !nextBlank : (lastTrailNL !== false);
    if (b.t === 'html') {
      out += b.text + (childTrailNL ? '\n' : '');
    } else {
      out += renderBlock(b, defs, childTrailNL);
    }
  }
  return out;
}
function renderItem(item, defs, tight, lastTrailNL) {
  let checkbox = '';
  let children = item.children;
  let firstParaCheckbox = null;
  if (children.length > 0 && children[0].t === 'paragraph') {
    const text = children[0].text;
    const m = /^\[[ xX]\][ \t]+(?=\S)/.exec(text);
    if (m) {
      const checked = text[1] === 'x' || text[1] === 'X';
      const cb = checked ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
      const newPara = { t: 'paragraph', text: text.slice(m[0].length), children: [] };
      if (tight) {
        checkbox = cb;
      } else {
        // Loose list: the checkbox stays inside the first <p>.
        firstParaCheckbox = cb;
      }
      children = [newPara, ...children.slice(1)];
    }
  }
  let body = '';
  if (tight) {
    for (const c of children) {
      if (c.t === 'paragraph') { if (c.text !== '' && !c.empty) body += renderInline(parseInline(c.text, defs, false)); }
      else body += renderBlock(c, defs, lastTrailNL);
    }
  } else {
    for (let k = 0; k < children.length; k++) {
      const c = children[k];
      if (c.t === 'paragraph') {
        if (c.text !== '' && !c.empty) {
          const inner = renderInline(parseInline(c.text, defs, false));
          body += '<p>' + (k === 0 && firstParaCheckbox ? firstParaCheckbox + ' ' + inner : inner) + '</p>\n';
        }
      } else body += renderBlock(c, defs, lastTrailNL);
    }
  }
  if (checkbox) body = checkbox + ' ' + body;
  return '<li>' + body + '</li>\n';
}
function renderBlock(b, defs, lastTrailNL) {
  switch (b.t) {
    case 'paragraph': {
      if (b.text === '' || b.empty) return '';
      return '<p>' + renderInline(parseInline(b.text, defs, false)) + '</p>\n';
    }
    case 'heading':
      return '<h' + b.level + '>' + renderInline(parseInline(b.text, defs, false)) + '</h' + b.level + '>\n';
    case 'code': {
      const langAttr = b.lang ? ' class="language-' + escapeText(b.lang) + '"' : '';
      return '<pre><code' + langAttr + '>' + escapeAll(b.text) + '</code></pre>\n';
    }
    case 'html': {
      // HTML blocks are output exactly as written (no trailing newline added).
      return b.text;
    }
    case 'thematic_break': return '<hr>\n';
    case 'blockquote':
      return '<blockquote>\n' + renderBlocks(b.children, defs, lastTrailNL) + '</blockquote>\n';
    case 'list': {
      const tag = b.listType === 'ordered' ? 'ol' : 'ul';
      const startAttr = b.listType === 'ordered' && b.start !== 1 ? ' start="' + b.start + '"' : '';
      let out = '<' + tag + startAttr + '>\n';
      for (const item of b.children) out += renderItem(item, defs, b.tight, lastTrailNL);
      out += '</' + tag + '>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < b.header.length; i++) {
        out += '<th' + (b.align[i] ? ' align="' + b.align[i] + '"' : '') + '>' + renderInline(parseInline(b.header[i], defs, false)) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length > 0) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let i = 0; i < row.length; i++) {
            out += '<td' + (b.align[i] ? ' align="' + b.align[i] + '"' : '') + '>' + renderInline(parseInline(row[i], defs, false)) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody></table>\n';
      } else {
        out += '</table>\n';
      }
      return out;
    }
    default:
      return '';
  }
}
// ============================== entry point ==============================
// parse(markdown) returns exactly the HTML marked 18.1.3 produces for the same
// input with default options (gfm true, breaks false, pedantic false, async false).
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  docInLink = false;
  const { root, defs } = parseBlocks(src);
  // Trailing newline for a final HTML block: yes if the source ends with a
  // single newline, no if it ends with a blank line or without a newline.
  const lastTrailNL = src.endsWith('\n') && !src.endsWith('\n\n');
  return renderBlocks(root.children, defs, lastTrailNL);
}
