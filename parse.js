
// --- block parsing ----------------------------------------------------------
// Blocks: para {lines}, heading {level, text}, code {fenced, info, lines},
// html {lines}, quote {ch}, list {ordered, start, tight, items}, item {ch},
// table {head, aligns, rows}, hr. `refs` collects link reference definitions.

const BLOCK_TAGS = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul'.split(' '));
const HTML_BLOCK_TAGS = BLOCK_TAGS;
const RAW_TAGS = ['script', 'pre', 'style', 'textarea'];

// Document-level "inside a link" flag (marked's lexer state.inLink).
// An inline <a ...> tag sets it and it stays set for the rest of the
// document until a </a> tag clears it; while set, GFM bare-URL and
// bare-email autolinks do not form. It is reset at the start of parse().
// Tags inside a link label do not touch it (marked restores the state
// after parsing a label).
let inLinkDoc = false;

function matchQuote(s, col0) {
  // Strip up to 3 columns, then '>', then one optional space. Returns
  // {rest, col} where col is the absolute column of the rest's first
  // character, or null when the line does not continue a blockquote.
  // col0 is the absolute column of s[0].
  const base = col0 === undefined ? 0 : col0;
  let i = 0;
  let col = base;
  while (i < s.length && col - base < 3) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  if (col - base > 3) return null;
  if (i >= s.length || s.charCodeAt(i) !== 62) return null;
  let rest = s.slice(i + 1);
  col++;
  // One optional space follows the '>'. A tab counts as that space but is
  // only partly consumed: the rest of the tab becomes spaces. Marked
  // expands that tab from the column of the marker in the line as
  // presented to the blockquote (after outer containers are stripped),
  // i.e. the tab's character index within s (i + 1), not the absolute
  // document column: a tab after '>' inside a list item would otherwise
  // expand from the wrong column (doc-30: 3 spaces instead of 2).
  if (rest.charCodeAt(0) === 32) { rest = rest.slice(1); col++; }
  else if (rest.charCodeAt(0) === 9) {
    const remain = (4 - ((i + 1) % 4)) - 1;
    rest = ' '.repeat(remain) + rest.slice(1);
    col++;
  }
  return { rest, col };
}

function parseAtx(s, col0) {
  let i = firstNonSpace(s);
  if (indentCols(s, col0) > 3) return null;
  let level = 0;
  while (i < s.length && s.charCodeAt(i) === 35 && level < 7) { level++; i++; }
  if (level === 0 || level > 6) return null;
  if (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  let text = s.slice(i);
  // strip leading/trailing whitespace and a closing sequence of #s
  let a = 0;
  while (a < text.length && (text.charCodeAt(a) === 32 || text.charCodeAt(a) === 9)) a++;
  let b = text.length;
  while (b > a && (text.charCodeAt(b - 1) === 32 || text.charCodeAt(b - 1) === 9)) b--;
  let e = b;
  while (e > a && text.charCodeAt(e - 1) === 35) e--;
  // a closing run: preceded by a space/tab, or the whole remaining text
  if (e < b && (e === a || text.charCodeAt(e - 1) === 32 || text.charCodeAt(e - 1) === 9)) {
    b = e;
    while (b > a && (text.charCodeAt(b - 1) === 32 || text.charCodeAt(b - 1) === 9)) b--;
  }
  return { level, text: text.slice(a, b) };
}

function parseFence(s, col0) {
  const base = col0 === undefined ? 0 : col0;
  if (indentCols(s, base) > 3) return null;
  const i = firstNonSpace(s);
  const ch = s.charCodeAt(i);
  if (ch !== 96 && ch !== 126) return null;
  let j = i;
  while (j < s.length && s.charCodeAt(j) === ch) j++;
  const len = j - i;
  if (len < 3) return null;
  const info = s.slice(j).trim();
  if (ch === 96 && info.indexOf('`') !== -1) return null;
  // the fence indent is relative to the stripped line's start; a tilde
  // fence never dedents its content (marked keeps the full indent),
  // while a backtick fence strips up to its indent. The dedent counts
  // leading whitespace CHARACTERS, not columns (marked's Dt): a tab in
  // the fence line or in a content line counts as one character, so it
  // is consumed whole instead of expanding to spaces first.
  return { ch: String.fromCharCode(ch), len, info, indent: ch === 126 ? 0 : indentCols(s, base), indentChars: ch === 126 ? 0 : i };
}

function isFenceClose(s, fence, col0) {
  if (indentCols(s, col0) > 3) return false;
  const i = firstNonSpace(s);
  const ch = s.charCodeAt(i);
  if (ch !== fence.ch.charCodeAt(0)) return false;
  let j = i;
  while (j < s.length && s.charCodeAt(j) === ch) j++;
  if (j - i < fence.len) return false;
  return s.slice(j).trim() === '';
}

function parseThematicBreak(s, col0) {
  if (indentCols(s, col0) > 3) return false;
  const i = firstNonSpace(s);
  const ch = s.charCodeAt(i);
  if (ch !== 42 && ch !== 45 && ch !== 95) return false;
  let count = 0;
  for (let k = i; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === ch) count++;
    else if (c !== 32 && c !== 9) return false;
  }
  return count >= 3;
}

function parseSetext(s, col0) {
  if (indentCols(s, col0) > 3) return 0;
  const i = firstNonSpace(s);
  const ch = s.charCodeAt(i);
  if (ch !== 61 && ch !== 45) return 0;
  let k = i;
  while (k < s.length && s.charCodeAt(k) === ch) k++;
  // the rest of the line must be only spaces/tabs (no spaces inside the run)
  while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
  if (k !== s.length) return 0;
  return ch === 61 ? 1 : 2;
}

// HTML block start: returns the type (1-7) or 0.
// Type 1: <script, <pre, <style, <textarea (opening tag; ends at its
//   closing tag, blank lines inside are kept).
// Type 2: <!-- (ends at -->), type 3: <? (ends at ?>),
// type 4: <! + letter (ends at >), type 5: <![CDATA[ (ends at ]]>).
// Type 6: a block tag (open or close); text may follow the tag on the line.
// Type 7: a complete open/close tag alone on the line (any tag name).
// Types 6-7 end at a blank line.
function htmlBlockType(s, col0) {
  if (indentCols(s, col0) > 3) return 0;
  const i = firstNonSpace(s);
  if (s.charCodeAt(i) !== 60) return 0;
  const rest = s.slice(i + 1);
  const m1 = /^(script|pre|style|textarea)(?:\s|>|$)/i.exec(rest);
  if (m1) return 1;
  if (rest.startsWith('!--')) return 2;
  if (rest.startsWith('?')) return 3;
  if (rest.startsWith('!')) {
    const c = rest.charCodeAt(1);
    if (c >= 65 && c <= 90) return 4;
  }
  if (rest.startsWith('![CDATA[')) return 5;
  // type 6: block tag (rest is the text after '<')
  const tagMatch = /^\/?([A-Za-z][A-Za-z0-9-]*)(?:\s|\/?>|$)/.exec(rest);
  if (tagMatch) {
    const name = tagMatch[1].toLowerCase();
    if (HTML_BLOCK_TAGS.has(name)) return 6;
    // type 7: a complete tag alone on the line
    const t = tryHtmlTag(s, i);
    if (t && s.slice(t.end).trim() === '') return 7;
  }
  return 0;
}

// The tag name of a type 1 HTML block start (script/pre/style/textarea).
function htmlType1Tag(s) {
  const i = firstNonSpace(s);
  const rest = s.slice(i + 1);
  const m = /^(script|pre|style|textarea)(?:\s|>|$)/i.exec(rest);
  return m ? m[1].toLowerCase() : null;
}

// Does `line` contain the closing tag </name> (case-insensitive, optional
// whitespace before '>')?
function containsCloseTag(line, name) {
  const lower = line.toLowerCase();
  const needle = '</' + name;
  let idx = lower.indexOf(needle);
  while (idx !== -1) {
    let k = idx + needle.length;
    while (k < lower.length && (lower.charCodeAt(k) === 32 || lower.charCodeAt(k) === 9)) k++;
    if (k < lower.length && lower.charCodeAt(k) === 62) return true;
    idx = lower.indexOf(needle, idx + 1);
  }
  return false;
}

// Does `line` contain the end marker for an HTML block of the given type?
function htmlEndMarker(line, type, tag) {
  if (type === 1) return tag ? containsCloseTag(line, tag) : false;
  if (type === 2) return line.indexOf('-->') !== -1;
  if (type === 3) return line.indexOf('?>') !== -1;
  if (type === 4) return line.indexOf('>') !== -1;
  if (type === 5) return line.indexOf(']]>') !== -1;
  return false;
}

// List marker: returns {ordered, start, markerLen, contentIndent, empty}
// or null. `s` is the line after container markers.
function parseListMarker(s, col0) {
  // A list marker at the start of `s`. col0 is the absolute column of
  // s[0]; the returned contentIndent is an absolute column.
  const base = col0 === undefined ? 0 : col0;
  if (indentCols(s, base) > 3) return null;
  const lead = indentCols(s, base);
  const i = firstNonSpace(s);
  const c = s.charCodeAt(i);
  let ordered = false;
  let start = 1;
  let j = i;
  if (c === 45 || c === 42 || c === 43) {
    j = i + 1;
  } else if (isDigit(c)) {
    let k = i;
    while (k < s.length && isDigit(s.charCodeAt(k))) k++;
    if (k - i > 9) return null;
    const d = s.charCodeAt(k);
    if (d !== 46 && d !== 41) return null;
    ordered = true;
    start = parseInt(s.slice(i, k), 10);
    j = k + 1;
  } else return null;
  // one to four columns of spaces (or a tab) after the marker, else the
  // item is empty
  if (j >= s.length) return { ordered, start, markerLen: j - i, contentIndent: lead + (j - i) + 1, empty: true };
  const d = s.charCodeAt(j);
  if (d !== 32 && d !== 9) return null;
  // count the spaces/tabs after the marker (absolute columns, so a tab
  // expands from its real position); the content indent itself is
  // relative to the stripped line's start
  const absStart = base + lead + (j - i);
  let col = 0;
  let k = j;
  while (k < s.length && col < 5) {
    const cc = s.charCodeAt(k);
    if (cc === 32) { col++; k++; }
    else if (cc === 9) { col += 4 - ((absStart + col) % 4); k++; }
    else break;
  }
  if (col === 0) return null;
  let contentIndent;
  let empty = false;
  if (k >= s.length) {
    empty = true;
    contentIndent = lead + (j - i) + 1;
  } else if (col >= 5) {
    contentIndent = lead + (j - i) + 1;
  } else {
    contentIndent = lead + (j - i) + col;
  }
  return { ordered, start, markerLen: j - i, contentIndent, empty };
}

// The content of a list item's marker line: the text after the marker and
// its following spaces (a tab straddling the content column becomes spaces).
function listItemContent(s, lm, col0) {
  const base = col0 === undefined ? 0 : col0;
  const lead = indentCols(s, base);
  let p = firstNonSpace(s) + lm.markerLen;
  let col = base + lead + lm.markerLen;
  const targetCol = base + lm.contentIndent;
  while (p < s.length && col < targetCol) {
    const c = s.charCodeAt(p);
    if (c === 32) { col++; p++; }
    else if (c === 9) {
      const next = col + (4 - (col % 4));
      if (next <= targetCol) { col = next; p++; }
      else return ' '.repeat(next - targetCol) + s.slice(p + 1);
    } else break;
  }
  return s.slice(p);
}

// Table delimiter row: returns the alignments array ('l','c','r',null) or null.
function parseTableDelimiter(s) {
  const cells = splitTableCells(s);
  if (cells === null) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    if (t.startsWith(':') && t.endsWith(':')) aligns.push('c');
    else if (t.endsWith(':')) aligns.push('r');
    else if (t.startsWith(':')) aligns.push('l');
    else aligns.push(null);
  }
  return aligns;
}

// Split a table row into cells (handling \| escapes and optional edge pipes).
// Returns null when the line has no pipe at all.
function splitTableCells(s) {
  let cells = [];
  let cur = '';
  let i = 0;
  let hasPipe = false;
  // skip leading spaces and an optional leading pipe
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (s.charCodeAt(i) === 124) { hasPipe = true; i++; }
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && s.charCodeAt(i + 1) === 124) {
      cur += '|';
      i++;
      continue;
    }
    if (c === 124) {
      hasPipe = true;
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += s[i];
  }
  cells.push(cur);
  if (!hasPipe) return null;
  // drop the trailing empty cell when the line ends with a pipe
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}

// --- character helpers ------------------------------------------------------
function isDigit(c) { return c >= 48 && c <= 57; }
function isHex(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isSpace(c) { return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13; }
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
const UNICODE_PUNCT = /^[\p{P}\p{S}]$/u;
function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  return isAsciiPunct(c) || UNICODE_PUNCT.test(ch);
}
function isWhitespaceCh(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\v' || ch === '\f' || ch === '\r' || /\s/.test(ch);
}
function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Columns of leading whitespace. col0 is the absolute column of s[0];
// tabs advance to the next multiple of 4 from that column. Returns the
// indent relative to col0.
function indentCols(s, col0) {
  const base = col0 === undefined ? 0 : col0;
  let col = base;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else break;
  }
  return col - base;
}
// Remove `n` columns of leading whitespace; a tab straddling the boundary
// becomes spaces. col0 is the absolute column of s[0]; the result's first
// character sits at absolute column col0 + n.
function stripCols(s, n, col0) {
  const base = col0 === undefined ? 0 : col0;
  const target = base + n;
  let col = base;
  let i = 0;
  while (i < s.length && col < target) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const next = col + (4 - (col % 4));
      if (next <= target) { col = next; i++; }
      else return ' '.repeat(next - target) + s.slice(i + 1);
    } else break;
  }
  return s.slice(i);
}
// Remove up to `n` leading whitespace characters (space or tab) from a
// fenced-code content line. This mirrors marked's fence dedent: it counts
// characters, not columns, so a leading tab is consumed whole (one
// character) instead of expanding to spaces and leaving a remainder.
function stripFenceIndent(s, n) {
  let i = 0;
  while (i < s.length && i < n) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  return s.slice(i);
}
function firstNonSpace(s) {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  return i;
}

// Expand the first tab found in the leading whitespace of `s` to spaces.
// col0 is the absolute column of s[0]; outer is the width of the
// container markers outside the innermost container (the tab's effective
// column is col0 - outer plus its offset within the leading whitespace).
// Returns s unchanged when there is no tab in the leading whitespace.
function expandTabInIndent(s, col0, outer) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32) i++;
  if (i >= s.length || s.charCodeAt(i) !== 9) return s;
  const col = (col0 === undefined ? 0 : col0) + i - (outer === undefined ? 0 : outer);
  return s.slice(0, i) + ' '.repeat(4 - (col % 4)) + s.slice(i + 1);
}

// Expand a leading tab to spaces, to the next multiple of 4 from the
// absolute column col0. Used after a container (list item or blockquote)
// strips its indent: a tab left at the start of the stripped line is
// expanded to spaces from its absolute column (a tab at column 13
// becomes 3 spaces, at column 7 becomes 1 space). A fenced code block
// at the top level keeps a literal tab, so this is only applied to
// lines that went through container stripping.
function expandLeadingTab(s, col0) {
  if (s.charCodeAt(0) !== 9) return s;
  const col = col0 === undefined ? 0 : col0;
  return ' '.repeat(4 - (col % 4)) + s.slice(1);
}

// --- entities ---------------------------------------------------------------
// All 2,125 HTML5 named character references (WHATWG entities.json).
const ENTITY_NAMES = 'AElig AMP Aacute Abreve Acirc Acy Afr Agrave Alpha Amacr And Aogon Aopf ApplyFunction Aring Ascr Assign Atilde Auml Backslash Barv Barwed Bcy Because Bernoullis Beta Bfr Bopf Breve Bscr Bumpeq CHcy COPY Cacute Cap CapitalDifferentialD Cayleys Ccaron Ccedil Ccirc Cconint Cdot Cedilla CenterDot Cfr Chi CircleDot CircleMinus CirclePlus CircleTimes ClockwiseContourIntegral CloseCurlyDoubleQuote CloseCurlyQuote Colon Colone Congruent Conint ContourIntegral Copf Coproduct CounterClockwiseContourIntegral Cross Cscr Cup CupCap DD DDotrahd DJcy DScy DZcy Dagger Darr Dashv Dcaron Dcy Del Delta Dfr DiacriticalAcute DiacriticalDot DiacriticalDoubleAcute DiacriticalGrave DiacriticalTilde Diamond DifferentialD Dopf Dot DotDot DotEqual DoubleContourIntegral DoubleDot DoubleDownArrow DoubleLeftArrow DoubleLeftRightArrow DoubleLeftTee DoubleLongLeftArrow DoubleLongLeftRightArrow DoubleLongRightArrow DoubleRightArrow DoubleRightTee DoubleUpArrow DoubleUpDownArrow DoubleVerticalBar DownArrow DownArrowBar DownArrowUpArrow DownBreve DownLeftRightVector DownLeftTeeVector DownLeftVector DownLeftVectorBar DownRightTeeVector DownRightVector DownRightVectorBar DownTee DownTeeArrow Downarrow Dscr Dstrok ENG ETH Eacute Ecaron Ecirc Ecy Edot Efr Egrave Element Emacr EmptySmallSquare EmptyVerySmallSquare Eogon Eopf Epsilon Equal EqualTilde Equilibrium Escr Esim Eta Euml Exists ExponentialE Fcy Ffr FilledSmallSquare FilledVerySmallSquare Fopf ForAll Fouriertrf Fscr GJcy GT Gamma Gammad Gbreve Gcedil Gcirc Gcy Gdot Gfr Gg Gopf GreaterEqual GreaterEqualLess GreaterFullEqual GreaterGreater GreaterLess GreaterSlantEqual GreaterTilde Gscr Gt HARDcy Hacek Hat Hcirc Hfr HilbertSpace Hopf HorizontalLine Hscr Hstrok HumpDownHump HumpEqual IEcy IJlig IOcy Iacute Icirc Icy Idot Ifr Igrave Im Imacr ImaginaryI Implies Int Integral Intersection InvisibleComma InvisibleTimes Iogon Iopf Iota Iscr Itilde Iukcy Iuml Jcirc Jcy Jfr Jopf Jscr Jsercy Jukcy KHcy KJcy Kappa Kcedil Kcy Kfr Kopf Kscr LJcy LT Lacute Lambda Lang Laplacetrf Larr Lcaron Lcedil Lcy LeftAngleBracket LeftArrow LeftArrowBar LeftArrowRightArrow LeftCeiling LeftDoubleBracket LeftDownTeeVector LeftDownVector LeftDownVectorBar LeftFloor LeftRightArrow LeftRightVector LeftTee LeftTeeArrow LeftTeeVector LeftTriangle LeftTriangleBar LeftTriangleEqual LeftUpDownVector LeftUpTeeVector LeftUpVector LeftUpVectorBar LeftVector LeftVectorBar Leftarrow Leftrightarrow LessEqualGreater LessFullEqual LessGreater LessLess LessSlantEqual LessTilde Lfr Ll Lleftarrow Lmidot LongLeftArrow LongLeftRightArrow LongRightArrow Longleftarrow Longleftrightarrow Longrightarrow Lopf LowerLeftArrow LowerRightArrow Lscr Lsh Lstrok Lt Map Mcy MediumSpace Mellintrf Mfr MinusPlus Mopf Mscr Mu NJcy Nacute Ncaron Ncedil Ncy NegativeMediumSpace NegativeThickSpace NegativeThinSpace NegativeVeryThinSpace NestedGreaterGreater NestedLessLess NewLine Nfr NoBreak NonBreakingSpace Nopf Not NotCongruent NotCupCap NotDoubleVerticalBar NotElement NotEqual NotEqualTilde NotExists NotGreater NotGreaterEqual NotGreaterFullEqual NotGreaterGreater NotGreaterLess NotGreaterSlantEqual NotGreaterTilde NotHumpDownHump NotHumpEqual NotLeftTriangle NotLeftTriangleBar NotLeftTriangleEqual NotLess NotLessEqual NotLessGreater NotLessLess NotLessSlantEqual NotLessTilde NotNestedGreaterGreater NotNestedLessLess NotPrecedes NotPrecedesEqual NotPrecedesSlantEqual NotReverseElement NotRightTriangle NotRightTriangleBar NotRightTriangleEqual NotSquareSubset NotSquareSubsetEqual NotSquareSuperset NotSquareSupersetEqual NotSubset NotSubsetEqual NotSucceeds NotSucceedsEqual NotSucceedsSlantEqual NotSucceedsTilde NotSuperset NotSupersetEqual NotTilde NotTildeEqual NotTildeFullEqual NotTildeTilde NotVerticalBar Nscr Ntilde Nu OElig Oacute Ocirc Ocy Odblac Ofr Ograve Omacr Omega Omicron Oopf OpenCurlyDoubleQuote OpenCurlyQuote Or Oscr Oslash Otilde Otimes Ouml OverBar OverBrace OverBracket OverParenthesis PartialD Pcy Pfr Phi Pi PlusMinus Poincareplane Popf Pr Precedes PrecedesEqual PrecedesSlantEqual PrecedesTilde Prime Product Proportion Proportional Pscr Psi QUOT Qfr Qopf Qscr RBarr REG Racute Rang Rarr Rarrtl Rcaron Rcedil Rcy Re ReverseElement ReverseEquilibrium ReverseUpEquilibrium Rfr Rho RightAngleBracket RightArrow RightArrowBar RightArrowLeftArrow RightCeiling RightDoubleBracket RightDownTeeVector RightDownVector RightDownVectorBar RightFloor RightTee RightTeeArrow RightTeeVector RightTriangle RightTriangleBar RightTriangleEqual RightUpDownVector RightUpTeeVector RightUpVector RightUpVectorBar RightVector RightVectorBar Rightarrow Ropf RoundImplies Rrightarrow Rscr Rsh RuleDelayed SHCHcy SHcy SOFTcy Sacute Sc Scaron Scedil Scirc Scy Sfr ShortDownArrow ShortLeftArrow ShortRightArrow ShortUpArrow Sigma SmallCircle Sopf Sqrt Square SquareIntersection SquareSubset SquareSubsetEqual SquareSuperset SquareSupersetEqual SquareUnion Sscr Star Sub Subset SubsetEqual Succeeds SucceedsEqual SucceedsSlantEqual SucceedsTilde SuchThat Sum Sup Superset SupersetEqual Supset THORN TRADE TSHcy TScy Tab Tau Tcaron Tcedil Tcy Tfr Therefore Theta ThickSpace ThinSpace Tilde TildeEqual TildeFullEqual TildeTilde Topf TripleDot Tscr Tstrok Uacute Uarr Uarrocir Ubrcy Ubreve Ucirc Ucy Udblac Ufr Ugrave Umacr UnderBar UnderBrace UnderBracket UnderParenthesis Union UnionPlus Uogon Uopf UpArrow UpArrowBar UpArrowDownArrow UpDownArrow UpEquilibrium UpTee UpTeeArrow Uparrow Updownarrow UpperLeftArrow UpperRightArrow Upsi Upsilon Uring Uscr Utilde Uuml VDash Vbar Vcy Vdash Vdashl Vee Verbar Vert VerticalBar VerticalLine VerticalSeparator VerticalTilde VeryThinSpace Vfr Vopf Vscr Vvdash Wcirc Wedge Wfr Wopf Wscr Xfr Xi Xopf Xscr YAcy YIcy YUcy Yacute Ycirc Ycy Yfr Yopf Yscr Yuml ZHcy Zacute Zcaron Zcy Zdot ZeroWidthSpace Zeta Zfr Zopf Zscr aacute abreve ac acE acd acirc acute acy aelig af afr agrave alefsym aleph alpha amacr amalg amp and andand andd andslope andv ang ange angle angmsd angmsdaa angmsdab angmsdac angmsdad angmsdae angmsdaf angmsdag angmsdah angrt angrtvb angrtvbd angsph angst angzarr aogon aopf ap apE apacir ape apid apos approx approxeq aring ascr ast asymp asympeq atilde auml awconint awint bNot backcong backepsilon backprime backsim backsimeq barvee barwed barwedge bbrk bbrktbrk bcong bcy bdquo becaus because bemptyv bepsi bernou beta beth between bfr bigcap bigcirc bigcup bigodot bigoplus bigotimes bigsqcup bigstar bigtriangledown bigtriangleup biguplus bigvee bigwedge bkarow blacklozenge blacksquare blacktriangle blacktriangledown blacktriangleleft blacktriangleright blank blk12 blk14 blk34 block bne bnequiv bnot bopf bot bottom bowtie boxDL boxDR boxDl boxDr boxH boxHD boxHU boxHd boxHu boxUL boxUR boxUl boxUr boxV boxVH boxVL boxVR boxVh boxVl boxVr boxbox boxdL boxdR boxdl boxdr boxh boxhD boxhU boxhd boxhu boxminus boxplus boxtimes boxuL boxuR boxul boxur boxv boxvH boxvL boxvR boxvh boxvl boxvr bprime breve brvbar bscr bsemi bsim bsime bsol bsolb bsolhsub bull bullet bump bumpE bumpe bumpeq cacute cap capand capbrcup capcap capcup capdot caps caret caron ccaps ccaron ccedil ccirc ccups ccupssm cdot cedil cemptyv cent centerdot cfr chcy check checkmark chi cir cirE circ circeq circlearrowleft circlearrowright circledR circledS circledast circledcirc circleddash cire cirfnint cirmid cirscir clubs clubsuit colon colone coloneq comma commat comp compfn complement complexes cong congdot conint copf coprod copy copysr crarr cross cscr csub csube csup csupe ctdot cudarrl cudarrr cuepr cuesc cularr cularrp cup cupbrcap cupcap cupcup cupdot cupor cups curarr curarrm curlyeqprec curlyeqsucc curlyvee curlywedge curren curvearrowleft curvearrowright cuvee cuwed cwconint cwint cylcty dArr dHar dagger daleth darr dash dashv dbkarow dblac dcaron dcy dd ddagger ddarr ddotseq deg delta demptyv dfisht dfr dharl dharr diam diamond diamondsuit diams die digamma disin div divide divideontimes divonx djcy dlcorn dlcrop dollar dopf dot doteq doteqdot dotminus dotplus dotsquare doublebarwedge downarrow downdownarrows downharpoonleft downharpoonright drbkarow drcorn drcrop dscr dscy dsol dstrok dtdot dtri dtrif duarr duhar dwangle dzcy dzigrarr eDDot eDot eacute easter ecaron ecir ecirc ecolon ecy edot ee efDot efr eg egrave egs egsdot el elinters ell els elsdot emacr empty emptyset emptyv emsp emsp13 emsp14 eng ensp eogon eopf epar eparsl eplus epsi epsilon epsiv eqcirc eqcolon eqsim eqslantgtr eqslantless equals equest equiv equivDD eqvparsl erDot erarr escr esdot esim eta eth euml euro excl exist expectation exponentiale fallingdotseq fcy female ffilig fflig ffllig ffr filig fjlig flat fllig fltns fnof fopf forall fork forkv fpartint frac12 frac13 frac14 frac15 frac16 frac18 frac23 frac25 frac34 frac35 frac38 frac45 frac56 frac58 frac78 frasl frown fscr gE gEl gacute gamma gammad gap gbreve gcirc gcy gdot ge gel geq geqq geqslant ges gescc gesdot gesdoto gesdotol gesl gesles gfr gg ggg gimel gjcy gl glE gla glj gnE gnap gnapprox gne gneq gneqq gnsim gopf grave gscr gsim gsime gsiml gt gtcc gtcir gtdot gtlPar gtquest gtrapprox gtrarr gtrdot gtreqless gtreqqless gtrless gtrsim gvertneqq gvnE hArr hairsp half hamilt hardcy harr harrcir harrw hbar hcirc hearts heartsuit hellip hercon hfr hksearow hkswarow hoarr homtht hookleftarrow hookrightarrow hopf horbar hscr hslash hstrok hybull hyphen iacute ic icirc icy iecy iexcl iff ifr igrave ii iiiint iiint iinfin iiota ijlig imacr image imagline imagpart imath imof imped in incare infin infintie inodot int intcal integers intercal intlarhk intprod iocy iogon iopf iota iprod iquest iscr isin isinE isindot isins isinsv isinv it itilde iukcy iuml jcirc jcy jfr jmath jopf jscr jsercy jukcy kappa kappav kcedil kcy kfr kgreen khcy kjcy kopf kscr lAarr lArr lAtail lBarr lE lEg lHar lacute laemptyv lagran lambda lang langd langle lap laquo larr larrb larrbfs larrfs larrhk larrlp larrpl larrsim larrtl lat latail late lates lbarr lbbrk lbrace lbrack lbrke lbrksld lbrkslu lcaron lcedil lceil lcub lcy ldca ldquo ldquor ldrdhar ldrushar ldsh le leftarrow leftarrowtail leftharpoondown leftharpoonup leftleftarrows leftrightarrow leftrightarrows leftrightharpoons leftrightsquigarrow leftthreetimes leg leq leqq leqslant les lescc lesdot lesdoto lesdotor lesg lesges lessapprox lessdot lesseqgtr lesseqqgtr lessgtr lesssim lfisht lfloor lfr lg lgE lhard lharu lharul lhblk ljcy ll llarr llcorner llhard lltri lmidot lmoust lmoustache lnE lnap lnapprox lne lneq lneqq lnsim loang loarr lobrk longleftarrow longleftrightarrow longmapsto longrightarrow looparrowleft looparrowright lopar lopf loplus lotimes lowast lowbar loz lozenge lozf lpar lparlt lrarr lrcorner lrhar lrhard lrm lrtri lsaquo lscr lsh lsim lsime lsimg lsqb lsquo lsquor lstrok lt ltcc ltcir ltdot lthree ltimes ltlarr ltquest ltrPar ltri ltrie ltrif lurdshar luruhar lvertneqq lvnE mDDot macr male malt maltese map mapsto mapstodown mapstoleft mapstoup marker mcomma mcy mdash measuredangle mfr mho micro mid midast midcir middot minus minusb minusd minusdu mlcp mldr mnplus models mopf mp mscr mstpos mu multimap mumap nGg nGt nGtv nLeftarrow nLeftrightarrow nLl nLt nLtv nRightarrow nVDash nVdash nabla nacute nang nap napE napid napos napprox natur natural naturals nbsp nbump nbumpe ncap ncaron ncedil ncong ncongdot ncup ncy ndash ne neArr nearhk nearr nearrow nedot nequiv nesear nesim nexist nexists nfr ngE nge ngeq ngeqq ngeqslant nges ngsim ngt ngtr nhArr nharr nhpar ni nis nisd niv njcy nlArr nlE nlarr nldr nle nleftarrow nleftrightarrow nleq nleqq nleqslant nles nless nlsim nlt nltri nltrie nmid nopf not notin notinE notindot notinva notinvb notinvc notni notniva notnivb notnivc npar nparallel nparsl npart npolint npr nprcue npre nprec npreceq nrArr nrarr nrarrc nrarrw nrightarrow nrtri nrtrie nsc nsccue nsce nscr nshortmid nshortparallel nsim nsime nsimeq nsmid nspar nsqsube nsqsupe nsub nsubE nsube nsubset nsubseteq nsubseteqq nsucc nsucceq nsup nsupE nsupe nsupset nsupseteq nsupseteqq ntgl ntilde ntlg ntriangleleft ntrianglelefteq ntriangleright ntrianglerighteq nu num numero numsp nvDash nvHarr nvap nvdash nvge nvgt nvinfin nvlArr nvle nvlt nvltrie nvrArr nvrtrie nvsim nwArr nwarhk nwarr nwarrow nwnear oS oacute oast ocir ocirc ocy odash odblac odiv odot odsold oelig ofcir ofr ogon ograve ogt ohbar ohm oint olarr olcir olcross oline olt omacr omega omicron omid ominus oopf opar operp oplus or orarr ord order orderof ordf ordm origof oror orslope orv oscr oslash osol otilde otimes otimesas ouml ovbar par para parallel parsim parsl part pcy percnt period permil perp pertenk pfr phi phiv phmmat phone pi pitchfork piv planck planckh plankv plus plusacir plusb pluscir plusdo plusdu pluse plusmn plussim plustwo pm pointint popf pound pr prE prap prcue pre prec precapprox preccurlyeq preceq precnapprox precneqq precnsim precsim prime primes prnE prnap prnsim prod profalar profline profsurf prop propto prsim prurel pscr psi puncsp qfr qint qopf qprime qscr quaternions quatint quest questeq quot rAarr rArr rAtail rBarr rHar race racute radic raemptyv rang rangd range rangle raquo rarr rarrap rarrb rarrbfs rarrc rarrfs rarrhk rarrlp rarrpl rarrsim rarrtl rarrw ratail ratio rationals rbarr rbbrk rbrace rbrack rbrke rbrksld rbrkslu rcaron rcedil rceil rcub rcy rdca rdldhar rdquo rdquor rdsh real realine realpart reals rect reg rfisht rfloor rfr rhard rharu rharul rho rhov rightarrow rightarrowtail rightharpoondown rightharpoonup rightleftarrows rightleftharpoons rightrightarrows rightsquigarrow rightthreetimes ring risingdotseq rlarr rlhar rlm rmoust rmoustache rnmid roang roarr robrk ropar ropf roplus rotimes rpar rpargt rppolint rrarr rsaquo rscr rsh rsqb rsquo rsquor rthree rtimes rtri rtrie rtrif rtriltri ruluhar rx sacute sbquo sc scE scap scaron sccue sce scedil scirc scnE scnap scnsim scpolint scsim scy sdot sdotb sdote seArr searhk searr searrow sect semi seswar setminus setmn sext sfr sfrown sharp shchcy shcy shortmid shortparallel shy sigma sigmaf sigmav sim simdot sime simeq simg simgE siml simlE simne simplus simrarr slarr smallsetminus smashp smeparsl smid smile smt smte smtes softcy sol solb solbar sopf spades spadesuit spar sqcap sqcaps sqcup sqcups sqsub sqsube sqsubset sqsubseteq sqsup sqsupe sqsupset sqsupseteq squ square squarf squf srarr sscr ssetmn ssmile sstarf star starf straightepsilon straightphi strns sub subE subdot sube subedot submult subnE subne subplus subrarr subset subseteq subseteqq subsetneq subsetneqq subsim subsub subsup succ succapprox succcurlyeq succeq succnapprox succneqq succnsim succsim sum sung sup sup1 sup2 sup3 supE supdot supdsub supe supedot suphsol suphsub suplarr supmult supnE supne supplus supset supseteq supseteqq supsetneq supsetneqq supsim supsub supsup swArr swarhk swarr swarrow swnwar szlig target tau tbrk tcaron tcedil tcy tdot telrec tfr there4 therefore theta thetasym thetav thickapprox thicksim thinsp thkap thksim thorn tilde times timesb timesbar timesd tint toea top topbot topcir topf topfork tosa tprime trade triangle triangledown triangleleft trianglelefteq triangleq triangleright trianglerighteq tridot trie triminus triplus trisb tritime trpezium tscr tscy tshcy tstrok twixt twoheadleftarrow twoheadrightarrow uArr uHar uacute uarr ubrcy ubreve ucirc ucy udarr udblac udhar ufisht ufr ugrave uharl uharr uhblk ulcorn ulcorner ulcrop ultri umacr uml uogon uopf uparrow updownarrow upharpoonleft upharpoonright uplus upsi upsih upsilon upuparrows urcorn urcorner urcrop uring urtri uscr utdot utilde utri utrif uuarr uuml uwangle vArr vBar vBarv vDash vangrt varepsilon varkappa varnothing varphi varpi varpropto varr varrho varsigma varsubsetneq varsubsetneqq varsupsetneq varsupsetneqq vartheta vartriangleleft vartriangleright vcy vdash vee veebar veeeq vellip verbar vert vfr vltri vnsub vnsup vopf vprop vrtri vscr vsubnE vsubne vsupnE vsupne vzigzag wcirc wedbar wedge wedgeq weierp wfr wopf wp wr wreath wscr xcap xcirc xcup xdtri xfr xhArr xharr xi xlArr xlarr xmap xnis xodot xopf xoplus xotime xrArr xrarr xscr xsqcup xuplus xutri xvee xwedge yacute yacy ycirc ycy yen yfr yicy yopf yscr yucy yuml zacute zcaron zcy zdot zeetrf zeta zfr zhcy zigrarr zopf zscr zwj zwnj';
const ENTITY_SET = new Set(ENTITY_NAMES.split(' '));

// Is any prefix (1..32 chars) of `word` a known entity name?
function hasEntityPrefix(word) {
  const max = Math.min(word.length, 32);
  for (let len = 1; len <= max; len++) {
    if (ENTITY_SET.has(word.slice(0, len))) return true;
  }
  return false;
}

// At s[i] === '&': return {text, end} when a valid entity starts here, else null.
// A named reference is '&' + alphanumerics + ';' (any word, kept verbatim).
// A numeric reference is '&#' + 1-7 decimal digits or '&#x' + 1-6 hex digits
// + ';'; values 0, >0x10FFFF or surrogates become U+FFFD.
function entityAt(s, i) {
  const n = s.length;
  if (s.charCodeAt(i + 1) === 35) {
    // numeric: &#123; or &#x1F600; (also &#X..;)
    let j = i + 2;
    let hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    const start = j;
    while (j < n && (hex ? isHex(s.charCodeAt(j)) : isDigit(s.charCodeAt(j)))) j++;
    const digits = j - start;
    if (digits === 0 || digits > (hex ? 6 : 7)) return null;
    if (j >= n || s.charCodeAt(j) !== 59) return null;
    let cp = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return { text: String.fromCodePoint(cp), end: j + 1 };
  }
  // named: '&' + alphanumerics + ';', kept verbatim whatever the word is
  let j = i + 1;
  while (j < n && isAlnum(s.charCodeAt(j))) j++;
  if (j === i + 1 || j >= n || s.charCodeAt(j) !== 59) return null;
  return { text: s.slice(i, j + 1), end: j + 1 };
}

// Escape text, preserving valid entities.
function escapeText(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const e = entityAt(s, i);
      if (e) {
        // A decoded character that itself needs escaping is escaped
        // (e.g. &#34; -> &quot;); a named reference is kept verbatim.
        if (e.text.length === 1) {
          const d = e.text.charCodeAt(0);
          if (d === 38) { out += '&amp;'; i = e.end; continue; }
          if (d === 60) { out += '&lt;'; i = e.end; continue; }
          if (d === 62) { out += '&gt;'; i = e.end; continue; }
          if (d === 34) { out += '&quot;'; i = e.end; continue; }
          if (d === 39) { out += '&#39;'; i = e.end; continue; }
        }
        out += e.text;
        i = e.end;
        continue;
      }
      out += '&amp;';
      i++;
      continue;
    }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    out += s[i];
    i++;
  }
  return out;
}

// Escape without entity processing (code content).
function escapeRaw(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) out += '&amp;';
    else if (c === 60) out += '&lt;';
    else if (c === 62) out += '&gt;';
    else if (c === 34) out += '&quot;';
    else if (c === 39) out += '&#39;';
    else out += s[i];
  }
  return out;
}

function cleanUrl(url) {
  // encodeURI, but an existing %XX sequence is left alone (marked's
  // cleanUrl replaces %25 back to %); a URL encodeURI rejects is unusable.
  let enc;
  try { enc = encodeURI(url).replace(/%25/g, '%'); } catch { return null; }
  return escapeText(enc);
}

function normalizeLabel(label) {
  // Unicode case folding via the lower-upper-lower round trip, so that
  // e.g. ẞ and SS fold to the same key (CommonMark label matching).
  return label.replace(/\s+/g, ' ').trim().toLowerCase().toUpperCase().toLowerCase();
}

// Resolve backslash escapes: '\' + ASCII punctuation -> the punctuation.
function unescapeBackslash(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// --- inline parsing helpers -------------------------------------------------
// Find a closing backtick run of exactly `run` backticks at or after `j`.
// Returns the start index of the run, or -1.
function findCodeClose(src, j, run) {
  const n = src.length;
  let i = j;
  while (i < n) {
    if (src.charCodeAt(i) !== 96) { i++; continue; }
    let k = i;
    while (k < n && src.charCodeAt(k) === 96) k++;
    if (k - i === run) return i;
    i = k;
  }
  return -1;
}

// Scan a link label starting at src[i] === '['. Returns the index just after
// the matching ']' or -1. Handles nested brackets, backslash escapes, and
// fails on an unpaired backtick run inside the label. Label <= 999 chars.
// Is there another backtick after position `k` before the ']' that
// closes the label at the given bracket depth? A backtick run in a label
// needs some later backtick to be valid at all (even of a different
// length); a lone run with no backtick after it kills the label.
function hasLaterBacktick(src, k, depth) {
  const n = src.length;
  let d = depth;
  let j = k;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 91) { d++; j++; continue; }
    if (c === 93) {
      d--;
      if (d === 0) return false;
      j++;
      continue;
    }
    if (c === 96) return true;
    j++;
  }
  return false;
}

function scanLinkLabel(src, i) {
  const n = src.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 91) { depth++; j++; continue; }
    if (c === 93) {
      depth--;
      if (depth === 0) return j + 1;
      j++;
      continue;
    }
    if (c === 96) {
      let k = j;
      while (k < n && src.charCodeAt(k) === 96) k++;
      const run = k - j;
      // Backtick runs are consumed in pairs, greedily by position: a
      // run pairs with the next backtick run whatever its length (a
      // same-length pair is a code span, a mismatched pair is literal
      // text); a lone run with no backtick after it before the label
      // closes makes the whole label invalid. Exception: a run that
      // opens a code span whose interior runs are all shorter than it,
      // and whose closing run is immediately followed by the label's
      // closing ']', is a proper code span ending the label (the
      // interior runs are its content, not separate pairs).
      if (!hasLaterBacktick(src, k, depth)) return -1;
      // look for a same-length close that ends the label
      const close = findCodeClose(src, k, run);
      if (close !== -1) {
        // every interior run must be shorter than the delimiter
        let ok = true;
        let q = k;
        while (q < close) {
          if (src.charCodeAt(q) === 96) {
            let e = q;
            while (e < n && src.charCodeAt(e) === 96) e++;
            if (e - q >= run) { ok = false; break; }
            q = e;
          } else q++;
        }
        if (ok && depth === 1 && src.charCodeAt(close + run) === 93) {
          j = close + run;
          continue;
        }
      }
      // greedy pair with the next run
      let m = k;
      while (m < n && src.charCodeAt(m) !== 96) m++;
      while (m < n && src.charCodeAt(m) === 96) m++;
      j = m;
      continue;
    }
    if (j - i > 999) return -1;
    j++;
  }
  return -1;
}

// Parse the destination of a link: <...> or a bare run (balanced parens,
// backslash escapes). Returns {dest, end} or null.
function parseDest(src, i) {
  const n = src.length;
  if (src.charCodeAt(i) === 60) {
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92 && j + 1 < n && isAsciiPunct(src.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === 62) return { dest: unescapeBackslash(src.slice(i + 1, j)), end: j + 1 };
      if (c === 60 || c < 32) return null;
      j++;
    }
    return null;
  }
  let j = i;
  let depth = 0;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92 && j + 1 < n && isAsciiPunct(src.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === 40) { depth++; j++; continue; }
    if (c === 41) {
      if (depth === 0) break;
      depth--;
      j++;
      continue;
    }
    if (isSpace(c) || c < 32) break;
    j++;
  }
  if (j === i) return null;
  return { dest: unescapeBackslash(src.slice(i, j)), end: j };
}

// Parse a link title at src[i] ('"' / '\'' / '('). Returns {title, end} or null.
function parseTitle(src, i) {
  const n = src.length;
  const q = src.charCodeAt(i);
  if (q === 34 || q === 39) {
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92 && j + 1 < n && isAsciiPunct(src.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === q) return { title: unescapeBackslash(src.slice(i + 1, j)), end: j + 1 };
      j++;
    }
    return null;
  }
  if (q === 40) {
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92 && j + 1 < n && isAsciiPunct(src.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === 40) return null;
      if (c === 41) return { title: unescapeBackslash(src.slice(i + 1, j)), end: j + 1 };
      j++;
    }
    return null;
  }
  return null;
}

// Parse an inline link's (...) starting at src[i] === '('.
// Returns {dest, title, end} or null.
function parseInlineLink(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n && isSpace(src.charCodeAt(j))) j++;
  if (j >= n) return null;
  if (src.charCodeAt(j) === 41) return { dest: '', title: null, end: j + 1 };
  const d = parseDest(src, j);
  if (!d) return null;
  j = d.end;
  while (j < n && isSpace(src.charCodeAt(j))) j++;
  let title = null;
  if (j < n && (src.charCodeAt(j) === 34 || src.charCodeAt(j) === 39 || src.charCodeAt(j) === 40)) {
    const t = parseTitle(src, j);
    if (!t) return null;
    title = t.title;
    j = t.end;
    while (j < n && isSpace(src.charCodeAt(j))) j++;
  }
  if (j >= n || src.charCodeAt(j) !== 41) return null;
  return { dest: d.dest, title, end: j + 1 };
}

// Does any node (recursively) hold a link?
// Whether the parsed inline nodes hold a bracket link (an angle
// autolink inside a label is a nested link and does not count).
function containsLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === 2 && !nd.a) return true;
    if (nd.ch && containsLink(nd.ch)) return true;
  }
  return false;
}

// Plain text of a node list (image alt text): code/link/emphasis flattened,
// html and hard breaks omitted.
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 0) out += nd.s;
    else if (nd.t === 1) out += nd.s;
    else if (nd.t === 2 || nd.t === 7 || nd.t === 8 || nd.t === 9) out += plainText(nd.ch);
    else if (nd.t === 3) out += nd.alt;
    else if (nd.t === 6) out += nd.ch.repeat(nd.len);
  }
  return out;
}

// Scan a reference label starting at src[i] === '[' (the strict form used
// for link reference definitions and for the second label of a full
// reference link). A label holds no '[', ']', '<', '>', or unescaped
// backtick, may span a single newline that is not followed by a blank
// line, and must not be only whitespace. Returns the index just after ']'.
function scanRefLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 93) {
      if (normalizeLabel(src.slice(i + 1, j)).length === 0) return -1;
      return j + 1;
    }
    if (c === 91 || c === 60 || c === 62 || c === 96) return -1;
    if (c === 10) {
      // a newline inside a label is allowed only when the next line is
      // not blank
      let k = j + 1;
      while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
      if (k >= n || src.charCodeAt(k) === 10) return -1;
      j++;
      continue;
    }
    if (j - i > 999) return -1;
    j++;
  }
  return -1;
}

// Does a '<' inside the link label (label text src[labelStart..labelEnd))
// open a raw HTML tag or an autolink that runs past the end of the label?
// Such a label cannot be a link (marked's link-in-text check).
function labelTagExtends(src, labelStart, labelEnd) {
  let k = labelStart;
  while (k < labelEnd) {
    const c = src.charCodeAt(k);
    if (c === 92) { k += 2; continue; }
    if (c === 96) {
      let j = k;
      while (j < labelEnd && src.charCodeAt(j) === 96) j++;
      const run = j - k;
      const close = findCodeClose(src, j, run);
      if (close === -1) { k = j; continue; }
      k = close + run;
      continue;
    }
    if (c === 60) {
      const a = tryAngle(src, k);
      if (a && a.end > labelEnd) return true;
      const h = tryHtmlTag(src, k);
      if (h && h.end > labelEnd) return true;
      k++;
      continue;
    }
    k++;
  }
  return false;
}

// Try a link/image starting at src[i] === '['. Returns
// {href, title, ch, end} or null. Precedence: inline link, then full
// reference, collapsed reference, shortcut reference. A malformed inline
// link falls back to the shortcut; a well-formed full reference whose
// label is undefined fails outright (no shortcut fallback); a malformed
// second label falls back to the shortcut.
function tryLink(src, i, refs, isImage) {
  const labelEnd = scanLinkLabel(src, i);
  if (labelEnd === -1) return null;
  const labelText = src.slice(i + 1, labelEnd - 1);
  const n = src.length;
  let href = null;
  let title = null;
  let end = -1;
  const after = labelEnd;
  if (after < n && src.charCodeAt(after) === 40) {
    const r = parseInlineLink(src, after);
    if (r) {
      href = r.dest;
      title = r.title;
      end = r.end;
    } else {
      const key = normalizeLabel(labelText);
      const ref = key.length ? refs.get(key) : undefined;
      if (!ref) return null;
      href = ref.dest;
      title = ref.title;
      end = labelEnd;
    }
  } else if (after < n && src.charCodeAt(after) === 91) {
    if (after + 1 < n && src.charCodeAt(after + 1) === 93) {
      // collapsed reference [label][]
      const key = normalizeLabel(labelText);
      const ref = key.length ? refs.get(key) : undefined;
      if (!ref) return null;
      href = ref.dest;
      title = ref.title;
      end = after + 2;
    } else {
      const refEnd = scanRefLabel(src, after);
      if (refEnd !== -1) {
        const key = normalizeLabel(src.slice(after + 1, refEnd - 1));
        const ref = key.length ? refs.get(key) : undefined;
        if (!ref) return null;
        href = ref.dest;
        title = ref.title;
        end = refEnd;
      } else {
        const key = normalizeLabel(labelText);
        const ref = key.length ? refs.get(key) : undefined;
        if (!ref) return null;
        href = ref.dest;
        title = ref.title;
        end = labelEnd;
      }
    }
  } else {
    const key = normalizeLabel(labelText);
    const ref = key.length ? refs.get(key) : undefined;
    if (!ref) return null;
    href = ref.dest;
    title = ref.title;
    end = labelEnd;
  }
  // a '<' in the label that opens a tag running past the label kills it
  if (labelText.indexOf('<') !== -1 && labelTagExtends(src, i + 1, labelEnd)) return null;
  // parse the label as a link label: bare URLs, www. and email autolinks
  // do not form inside it (they stay plain text and do not block the
  // outer link); only a bracket link inside blocks it
  const ch = parseInlineNodes(labelText, refs, true);
  // a link's text may not hold a link; an image's alt text may (it is
  // flattened to plain text)
  if (!isImage && containsLink(ch)) return null;
  return { href, title, ch, end };
}

// Validate a candidate email address (local@domain), per marked's email
// pattern: the local part is [\w.+-]+, the domain is labels of
// [A-Za-z0-9_-] separated by '.', at least two labels, and every label
// after the first ends with an alphanumeric (so a.b- and a.b_ fail).
function validateEmail(email) {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return false;
  const local = email.slice(0, at);
  const dom = email.slice(at + 1);
  for (let i = 0; i < local.length; i++) {
    if (!isLocalCh(local.charCodeAt(i))) return false;
  }
  const labels = dom.split('.');
  if (labels.length < 2) return false;
  for (let li = 0; li < labels.length; li++) {
    const lab = labels[li];
    if (lab.length === 0) return false;
    for (let i = 0; i < lab.length; i++) {
      const c = lab.charCodeAt(i);
      if (!(isAlnum(c) || c === 45 || c === 95)) return false;
    }
    if (li > 0 && !isAlnum(lab.charCodeAt(lab.length - 1))) return false;
  }
  return true;
}

// Try an autolink <...> at src[i] === '<'. Returns {href, text, end} or null.
function tryAngle(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n && src.charCodeAt(j) !== 62) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32) return null;
    j++;
  }
  if (j >= n) return null;
  const content = src.slice(i + 1, j);
  if (content.length === 0) return null;
  if (validateEmail(content)) {
    return { href: 'mailto:' + content, text: content, end: j + 1 };
  }
  const colon = content.indexOf(':');
  if (colon >= 2 && colon <= 32) {
    let ok = true;
    for (let k = 0; k < colon; k++) {
      const c = content.charCodeAt(k);
      if (!isAlnum(c) && c !== 43 && c !== 45 && c !== 46) { ok = false; break; }
    }
    if (ok && colon < content.length - 1) {
      return { href: content, text: content, end: j + 1 };
    }
  }
  return null;
}

// Scan an inline HTML tag starting at src[i] === '<'. Returns {end} or null.
// A comment is <!-- followed by an abrupt close (">" or "->") or by text up
// to the first -->. An open tag's attributes must each be preceded by
// whitespace (so <m:abc> and <a href='bar'title=title> are not tags), and a
// closing tag takes no attributes at all.
function tryHtmlTag(src, i) {
  const n = src.length;
  if (i + 1 >= n) return null;
  // comment
  if (src.startsWith('<!--', i)) {
    if (src.charCodeAt(i + 4) === 62) return { end: i + 5 };
    if (src.startsWith('->', i + 4)) return { end: i + 6 };
    const e = src.indexOf('-->', i + 4);
    if (e === -1) return null;
    return { end: e + 3 };
  }
  // CDATA
  if (src.startsWith('<![CDATA[', i)) {
    const e = src.indexOf(']]>', i + 9);
    if (e === -1) return null;
    return { end: e + 3 };
  }
  // processing instruction
  if (src.startsWith('<?', i)) {
    const e = src.indexOf('?>', i + 2);
    if (e === -1) return null;
    return { end: e + 2 };
  }
  // declaration <!A...>
  if (src.startsWith('<!', i)) {
    const c = src.charCodeAt(i + 2);
    if (isAlpha(c)) {
      const e = src.indexOf('>', i + 2);
      if (e === -1) return null;
      return { end: e + 1 };
    }
    return null;
  }
  // open / close tag
  let j = i + 1;
  let closing = false;
  if (src.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= n || !isAlpha(src.charCodeAt(j))) return null;
  while (j < n && (isAlnum(src.charCodeAt(j)) || src.charCodeAt(j) === 45)) j++;
  if (closing) {
    // a closing tag is only whitespace and '>'
    while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
    if (j < n && src.charCodeAt(j) === 62) return { end: j + 1 };
    return null;
  }
  // the tag name must be followed by whitespace, '/' or '>'
  if (j < n) {
    const c0 = src.charCodeAt(j);
    if (!(c0 === 32 || c0 === 9 || c0 === 10 || c0 === 47 || c0 === 62)) return null;
  }
  // attributes, each preceded by whitespace
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 62) return { end: j + 1 };
    if (c === 47 && j + 1 < n && src.charCodeAt(j + 1) === 62) return { end: j + 2 };
    if (c === 32 || c === 9 || c === 10) { j++; continue; }
    // an attribute name must follow whitespace
    if (!(isAlpha(c) || c === 95 || c === 58)) return null;
    j++;
    while (j < n) {
      const d = src.charCodeAt(j);
      if (isAlnum(d) || d === 95 || d === 58 || d === 45 || d === 46) j++;
      else break;
    }
    // optional = value
    let hadValue = false;
    let k = j;
    while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9 || src.charCodeAt(k) === 10)) k++;
    if (k < n && src.charCodeAt(k) === 61) {
      hadValue = true;
      k++;
      while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9 || src.charCodeAt(k) === 10)) k++;
      if (k < n && (src.charCodeAt(k) === 34 || src.charCodeAt(k) === 39)) {
        const q = src.charCodeAt(k);
        k++;
        while (k < n && src.charCodeAt(k) !== q) k++;
        if (k >= n) return null;
        j = k + 1;
      } else {
        while (k < n) {
          const d = src.charCodeAt(k);
          if (d === 32 || d === 9 || d === 10 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          k++;
        }
        j = k;
      }
    } else {
      j = k;
    }
    // after a value, only whitespace, '/' or '>' may follow; a letter
    // here means the next attribute was not separated by whitespace
    if (hadValue && j < n) {
      const d = src.charCodeAt(j);
      if (!(d === 32 || d === 9 || d === 10 || d === 47 || d === 62)) return null;
    }
  }
  return null;
}

function startsWithCI(src, i, prefix) {
  if (i + prefix.length > src.length) return false;
  for (let k = 0; k < prefix.length; k++) {
    const a = src.charCodeAt(i + k);
    const b = prefix.charCodeAt(k);
    const al = a >= 65 && a <= 90 ? a + 32 : a;
    const bl = b >= 65 && b <= 90 ? b + 32 : b;
    if (al !== bl) return false;
  }
  return true;
}

// Scan a URL run for an extended autolink: stops at whitespace, '<', or a
// control character. Returns the end index.
function scanUrlRun(src, i) {
  const n = src.length;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 60 || c < 32) break;
    j++;
  }
  return j;
}

// Is the trailing ')' of url (ending at `end`) kept? Kept only when the '('
// it matches has no '(' inside it.
function parenCloseOk(url, end) {
  let depth = 1;
  for (let k = end - 2; k >= 0; k--) {
    const c = url.charCodeAt(k);
    if (c === 41) depth++;
    else if (c === 40) {
      depth--;
      if (depth === 0) {
        // the '(' this ')' matches: its content must not contain '('
        return url.indexOf('(', k + 1) === -1 || url.indexOf('(', k + 1) >= end - 1;
      }
    }
  }
  return false;
}

// Trim a URL's end the way marked's backpedal does: a trailing
// '&word;' entity is dropped whole (checked before the ';' is treated as
// punctuation, and for any alphanumerics word, not just known entities),
// trailing punctuation ?!.,:;*_'\"~ is dropped, a trailing ')' is dropped
// when it is not balanced, and a trailing '&' is kept.
function trimUrlEnd(src, start, end) {
  let e = end;
  while (e > start) {
    const c = src.charCodeAt(e - 1);
    if (c === 59) { // ';'
      let k = e - 2;
      while (k >= start && isAlnum(src.charCodeAt(k))) k--;
      if (k >= start && src.charCodeAt(k) === 38 && e - k - 2 >= 1) { e = k; continue; }
      e--;
      continue;
    }
    if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 42 || c === 95 || c === 126 || c === 39 || c === 34) { e--; continue; }
    if (c === 41) {
      const url = src.slice(start, e);
      if (!parenCloseOk(url, url.length)) { e--; continue; }
      break;
    }
    break;
  }
  // cut at the first unmatched '('
  const url = src.slice(start, e);
  let depth = 0;
  let cut = -1;
  const stack = [];
  for (let k = 0; k < url.length; k++) {
    if (url.charCodeAt(k) === 40) stack.push(k);
    else if (url.charCodeAt(k) === 41) {
      if (stack.length > 0) stack.pop();
    }
  }
  if (stack.length > 0) cut = stack[0];
  if (cut !== -1) e = start + cut;
  return e;
}

// Extended autolink: http://, https://, ftp:// (case-insensitive).
function trySchemeUrl(src, i) {
  let schemeLen = 0;
  if (startsWithCI(src, i, 'http://')) schemeLen = 7;
  else if (startsWithCI(src, i, 'https://')) schemeLen = 8;
  else if (startsWithCI(src, i, 'ftp://')) schemeLen = 6;
  else return null;
  const runEnd = scanUrlRun(src, i);
  if (runEnd <= i + schemeLen) return null;
  const end = trimUrlEnd(src, i, runEnd);
  if (end <= i + schemeLen) return null;
  const text = src.slice(i, end);
  return { href: text, text, end };
}

// Extended autolink: www. (case-insensitive).
function tryWww(src, i) {
  // the www. autolink is lowercase only (Www. is not a link)
  if (!src.startsWith('www.', i)) return null;
  const after = src.charCodeAt(i + 4);
  if (!(isAlnum(after) || after === 45 || after === 95)) return null;
  const runEnd = scanUrlRun(src, i);
  const end = trimUrlEnd(src, i, runEnd);
  if (end <= i + 4) return null;
  const text = src.slice(i, end);
  return { href: 'http://' + text, text, end };
}

// Flanking info for a delimiter run src[i..j).
function delimInfo(src, i, j) {
  const prev = i > 0 ? src[i - 1] : '';
  const next = j < src.length ? src[j] : '';
  const prevWhitespace = prev === '' || isWhitespaceCh(prev);
  const nextWhitespace = next === '' || isWhitespaceCh(next);
  const prevPunct = prev !== '' && isPunctCh(prev);
  const nextPunct = next !== '' && isPunctCh(next);
  const leftFlanking = !nextWhitespace && (!nextPunct || prevWhitespace || prevPunct);
  const rightFlanking = !prevWhitespace && (!prevPunct || nextWhitespace || nextPunct);
  return { leftFlanking, rightFlanking, prevPunct, nextPunct };
}

// Emphasis: delimiter stack over the top-level nodes. A closer matches the
// nearest preceding opener with the same char (rule of 3 applied). Delimiters
// inside a newly formed element are dead (the list is rebuilt each round).
//
// Two marked quirks around an inner asterisk emphasis whose following text
// runs straight into the closer (no space after the inner element):
//  * Blocking: when the inner element is preceded by a space and the
//    closer is short (length 1 or 2, except a clean 1/1 em), the outer
//    emphasis does not form at all.
//  * Leftover inside: when the closer is longer (length 3+), the outer
//    emphasis forms but the extra closer delimiters become literal text
//    at the end of its content instead of a delimiter left outside.
// Both are asterisk-only: an inner underscore emphasis, code span, or
// link does not trigger them. A space after the inner element, or no
// text after it, means neither applies.
function processEmphasis(nodes) {
  let changed = true;
  while (changed) {
    changed = false;
    const delims = [];
    for (let idx = 0; idx < nodes.length; idx++) {
      if (nodes[idx].t === 6) delims.push({ idx, node: nodes[idx] });
    }
    for (let di = 0; di < delims.length; di++) {
      const closer = delims[di];
      if (!closer.node.c) continue;
      let opener = null;
      let leftoverInside = false;
      for (let oi = di - 1; oi >= 0; oi--) {
        const o = delims[oi];
        if (o.node.ch !== closer.node.ch) continue;
        if (!o.node.o) continue;
        if ((o.node.o && o.node.c) || (closer.node.o && closer.node.c)) {
          if ((o.node.len + closer.node.len) % 3 === 0 && !(o.node.len % 3 === 0 && closer.node.len % 3 === 0)) continue;
        }
        const use0 = o.node.len >= 2 && closer.node.len >= 2 ? 2 : 1;
        if (closer.node.ch === '*' && o.node.len === 1 && closer.node.len >= 2) {
          // A single '*' opener is dead when a closer-only '*' delimiter
          // sits between it and this longer closer: that delimiter is
          // the opener's natural partner and it already failed to match
          // (it is still an unmatched delimiter node), so the longer
          // closer must not resurrect the opener -- it matches the
          // longer opener instead (doc-11: the '*' after the inner
          // strong blocks the single '*' opener for the final '**').
          let dead = false;
          for (let ni = o.idx + 1; ni < closer.idx; ni++) {
            const nd = nodes[ni];
            if (nd.t === 6 && nd.ch === '*' && nd.c && !nd.o) { dead = true; break; }
          }
          if (dead) continue;
        }
        if (closer.node.ch === '*') {
          const kids = nodes.slice(o.idx + 1, closer.idx);
          let runsInAny = false;
          let runsInOpp = false;
          let blocked = false;
          for (let ci = 0; ci < kids.length; ci++) {
            const kid = kids[ci];
            if (kid.t !== 7 && kid.t !== 8) continue;
            if (kid.dc !== '*') continue;
            const tail = kids.slice(ci + 1);
            if (tail.length === 0) continue;
            // the text after the inner element must reach the closer
            // with nothing in between (no delimiter or element node)
            if (!tail.every((nd) => nd.t === 0)) continue;
            const first = tail[0];
            const s = first.s;
            let k = 0;
            while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 10 || s.charCodeAt(k) === 9)) k++;
            let runsIn = false;
            if (k === 0) {
              // the text must start with a word character to run into
              // the closer; punctuation after the inner element does
              // not interfere (cm-394)
              if (!isPunctCh(s[0])) runsIn = true;
            } else if (k === s.length && tail.length === 1) {
              runsIn = true;
            }
            if (!runsIn) continue;
            runsInAny = true;
            const opposite = (kid.t === 7 && use0 === 2) || (kid.t === 8 && use0 === 1);
            if (opposite) runsInOpp = true;
            const prev = kids[ci - 1];
            if (opposite && prev && prev.t === 0 && prev.s !== '') {
              const pc = prev.s.charCodeAt(prev.s.length - 1);
              if (pc === 32 || pc === 10 || pc === 9) blocked = true;
            }
          }
          if (runsInAny) {
            if (use0 < o.node.len) {
              // partial match (closer shorter than opener): any inner
              // emphasis running into the closer blocks it
              continue;
            }
            if (closer.node.len >= 3) {
              // long closer: an opposite-kind inner emphasis puts
              // the extra closer delimiters inside as literal text
              if (runsInOpp) {
                leftoverInside = true;
                opener = o;
                break;
              }
            } else if (blocked) {
              // short closer: an opposite-kind inner emphasis preceded
              // by a space blocks the outer emphasis
              continue;
            }
          }
        }
        opener = o;
        break;
      }
      if (!opener) continue;
      const use = opener.node.len >= 2 && closer.node.len >= 2 ? 2 : 1;
      const tag = closer.node.ch === '~' ? 9 : use === 2 ? 8 : 7;
      const children = nodes.slice(opener.idx + 1, closer.idx);
      const elem = { t: tag, ch: children, dc: closer.node.ch };
      opener.node.len -= use;
      closer.node.len -= use;
      const next = nodes.slice(0, opener.idx);
      if (opener.node.len > 0) next.push(opener.node);
      next.push(elem);
      if (closer.node.len > 0) {
        if (leftoverInside) {
          elem.ch.push({ t: 0, s: closer.node.ch.repeat(closer.node.len) });
        } else {
          next.push(closer.node);
        }
      }
      next.push(...nodes.slice(closer.idx + 1));
      nodes = next;
      changed = true;
      break;
    }
  }
  return nodes;
}

// Render a node list to HTML.
function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 0) out += escapeText(nd.s);
    else if (nd.t === 1) out += '<code>' + escapeRaw(nd.s) + '</code>';
    else if (nd.t === 2) {
      const href = cleanUrl(nd.h);
      if (href === null) { out += renderNodes(nd.ch); continue; }
      out += '<a href="' + href + '"';
      if (nd.ti !== null && nd.ti !== undefined) out += ' title="' + escapeText(nd.ti) + '"';
      out += '>' + renderNodes(nd.ch) + '</a>';
    } else if (nd.t === 3) {
      const src = cleanUrl(nd.s);
      if (src === null) { out += escapeText(nd.alt); continue; }
      out += '<img src="' + src + '" alt="' + escapeText(nd.alt) + '"';
      if (nd.ti !== null && nd.ti !== undefined) out += ' title="' + escapeText(nd.ti) + '"';
      out += '>';
    } else if (nd.t === 4) out += nd.s;
    else if (nd.t === 5) out += '<br>';
    else if (nd.t === 6) out += nd.ch.repeat(nd.len);
    else if (nd.t === 7) out += '<em>' + renderNodes(nd.ch) + '</em>';
    else if (nd.t === 8) out += '<strong>' + renderNodes(nd.ch) + '</strong>';
    else if (nd.t === 9) out += '<del>' + renderNodes(nd.ch) + '</del>';
  }
  return out;
}

function parseInline(src, refs) {
  return renderNodes(parseInlineNodes(src, refs));
}

// --- extended (GFM) autolinks: email ---------------------------------------
// The local part of an extended email autolink is [\w.+-]+.
function isLocalCh(c) {
  return isAlnum(c) || c === 46 || c === 95 || c === 43 || c === 45;
}
function isDomainCh(c) {
  return isAlnum(c) || c === 46 || c === 45 || c === 95;
}

// Forward email match starting at `i` (a local-part character). Returns
// {start, end, href, text} or null. The domain is the longest run of
// labels that satisfies the email pattern; a label's trailing '-' or '_'
// is not part of the label, and a trailing '_' that closes an open
// emphasis (hasOpenUnderscore) does not break the match.
function emailForward(src, i, hasOpenUnderscore) {
  const n = src.length;
  let j = i;
  while (j < n && isLocalCh(src.charCodeAt(j))) j++;
  if (j === i || j >= n || src.charCodeAt(j) !== 64) return null;
  // collect the end of each domain label (longest first); a label ends
  // at its last alphanumeric, trimming trailing '-' and '_'
  const ends = [];
  let e = j + 1;
  const start = e;
  while (e < n && isDomainCh(src.charCodeAt(e)) && src.charCodeAt(e) !== 46) e++;
  if (e === start) return null;
  let lastAlnum = -1;
  for (let k = start; k < e; k++) if (isAlnum(src.charCodeAt(k))) lastAlnum = k;
  if (lastAlnum === -1) return null;
  ends.push(lastAlnum + 1);
  let labels = 1;
  while (e < n && src.charCodeAt(e) === 46) {
    let k = e + 1;
    while (k < n && isDomainCh(src.charCodeAt(k)) && src.charCodeAt(k) !== 46) k++;
    if (k === e + 1) break;
    let la = -1;
    for (let m = e + 1; m < k; m++) if (isAlnum(src.charCodeAt(m))) la = m;
    if (la === -1) break;
    e = k;
    labels++;
    ends.push(la + 1);
  }
  // try the longest domain first; the lookahead fails when the next
  // character is a word character or '-', unless it is a '_' closing an
  // open emphasis
  for (let idx = ends.length - 1; idx >= 0; idx--) {
    const end = ends[idx];
    const count = idx + 1;
    if (count < 2) continue;
    if (end < n) {
      const c = src.charCodeAt(end);
      if (isAlnum(c) || c === 45) continue;
      if (c === 95 && !hasOpenUnderscore) continue;
    }
    const cand = src.slice(i, end);
    if (!validateEmail(cand)) continue;
    return { start: i, end, at: j, href: 'mailto:' + cand, text: cand };
  }
  return null;
}

// Extended autolink: xmpp:email with an optional single path segment.
function tryXmpp(src, i) {
  if (!startsWithCI(src, i, 'xmpp:')) return null;
  const r = emailForward(src, i + 5);
  if (!r) return null;
  let end = r.end;
  if (end < src.length && src.charCodeAt(end) === 47) {
    let k = end + 1;
    while (k < src.length) {
      const c = src.charCodeAt(k);
      if (isAlnum(c) || c === 64 || c === 46) k++;
      else break;
    }
    if (k > end + 1) end = k;
  }
  const text = src.slice(i, end);
  return { end, href: text, text };
}

// Does an emphasis pair start at the '_' run at `i` (before `at`)? If so the
// emphasis wins over an email whose local part starts there.
function underscoreEmAt(src, i, at) {
  let j = i;
  while (j < src.length && src.charCodeAt(j) === 95) j++;
  const openInfo = delimInfo(src, i, j);
  const canOpen = openInfo.leftFlanking && (!openInfo.rightFlanking || openInfo.prevPunct);
  if (!canOpen) return false;
  let k = j;
  while (k < at) {
    if (src.charCodeAt(k) === 95) break;
    k++;
  }
  if (k >= at) return false;
  let m = k;
  while (m < src.length && src.charCodeAt(m) === 95) m++;
  const closeInfo = delimInfo(src, k, m);
  const canClose = closeInfo.rightFlanking && (!closeInfo.leftFlanking || closeInfo.nextPunct);
  return canClose;
}

function tryMailto(src, i) {
  if (!startsWithCI(src, i, 'mailto:')) return null;
  const r = emailForward(src, i + 7);
  if (!r) return null;
  return { end: r.end, href: 'mailto:' + r.text, text: 'mailto:' + r.text };
}

// --- inline scanner ---------------------------------------------------------
// Node types: 0 text, 1 code, 2 link, 3 image, 4 raw html, 5 hard break,
// 6 emphasis delimiter run, 7 em, 8 strong, 9 del.
// Does `src` contain a code span whose content includes a backtick?
// (Used to suppress '_' emphasis inside a link label: marked does not
// form _..._ around such a code span when the label is a link label,
// though it does form it in plain text.)
function hasBacktickCodeSpan(src) {
  const n = src.length;
  let i = 0;
  while (i < n) {
    if (src.charCodeAt(i) !== 96) { i++; continue; }
    let j = i;
    while (j < n && src.charCodeAt(j) === 96) j++;
    const run = j - i;
    const close = findCodeClose(src, j, run);
    if (close === -1) { i = j; continue; }
    const content = src.slice(j, close);
    if (content.indexOf('`') !== -1) return true;
    i = close + run;
  }
  return false;
}

// --- marked-style emphasis mask -------------------------------------------
// marked decides emphasis and strikethrough on a masked copy of the
// paragraph: reference links that resolve, escaped punctuation, and inline
// links / code spans / HTML (its blockSkip) are replaced by placeholders
// of the same length, so delimiters inside them cannot open or close.
// The mask is length-preserving, so a delimiter at position i is hidden
// exactly when the masked text differs from the original there.
//
// The important case is a "phantom" code span. blockSkip's link pattern
// requires code spans inside a link label to have EQUAL backtick runs, so
// a label holding a mismatched run (`` ``small` ``) is not a link to the
// mask; the stray backtick then pairs with a LATER backtick and hides
// every delimiter between them, while the link itself still renders (the
// real link rule is lenient about the label). Reference links that
// resolve are masked first, so their labels never seed a phantom --
// except collapsed `[label][]` references, which the mask's lookup misses
// (it reads the label under the empty second bracket), so those DO seed
// one. The mask is computed once per inline text, before scanning.
const MASK_PUNCT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCK_SKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\()]|\\\((?:\\[\s\S]|[^\\()])*\\\))*\)|(?<!`)(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

// Blank out [start, end) in a char array with '[' + 'a'* + ']'.
function maskBlank(ch, start, end) {
  if (end - start < 2) return;
  ch[start] = '[';
  for (let k = start + 1; k < end - 1; k++) ch[k] = 'a';
  ch[end - 1] = ']';
}

// Scan a [ref] part starting at src[j] === '['. Backticks are ordinary
// characters here (marked's ref pattern allows them); '[' is not. Returns
// the index just after the closing ']' or -1.
function scanMaskRef(src, j) {
  const n = src.length;
  let k = j + 1;
  if (k >= n) return -1;
  while (k < n) {
    const c = src.charCodeAt(k);
    if (c === 92) { k += 2; continue; }
    if (c === 93) return k === j + 1 ? -1 : k + 1;
    if (c === 91) return -1;
    if (c === 10) {
      let m = k + 1;
      while (m < n && (src.charCodeAt(m) === 32 || src.charCodeAt(m) === 9)) m++;
      if (m >= n || src.charCodeAt(m) === 10) return -1;
      k++;
      continue;
    }
    k++;
  }
  return -1;
}

// Does text contain a link (inline or resolving reference)? Mirrors
// marked's linkInText: a full reference link whose own label contains a
// link does not count (it cannot itself form a link).
function labelHasLink(text, refs) {
  if (text.indexOf('[') === -1) return false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text.charCodeAt(i) !== 91) { i++; continue; }
    const labelEnd = scanLinkLabel(text, i);
    if (labelEnd === -1) { i++; continue; }
    const after = labelEnd;
    const notImage = i === 0 || text.charCodeAt(i - 1) !== 33;
    if (notImage && after < n && text.charCodeAt(after) === 40) {
      if (parseInlineLink(text, after)) return true;
      i++;
      continue;
    }
    if (after < n && text.charCodeAt(after) === 91) {
      if (after + 1 < n && text.charCodeAt(after + 1) === 93) { i = after + 2; continue; }
      const refEnd = scanMaskRef(text, after);
      if (refEnd === -1) { i++; continue; }
      const key = normalizeLabel(text.slice(after + 1, refEnd - 1));
      if (!key.length || !refs.has(key) || !notImage) { i++; continue; }
      const innerLabel = text.slice(i + 1, labelEnd - 1);
      if (!labelHasLink(innerLabel, refs)) return true;
      i = refEnd;
      continue;
    }
    const key = normalizeLabel(text.slice(i + 1, labelEnd - 1));
    if (key.length && refs.has(key) && notImage) return true;
    i++;
  }
  return false;
}

// Mask resolving reference links (full [label][ref] and shortcut [label]).
// Collapsed [label][] is deliberately not masked (see the note above).
// Returns a new string of the same length.
function maskReflinks(src, refs) {
  const n = src.length;
  const ch = src.split('');
  let i = 0;
  while (i < n) {
    if (src.charCodeAt(i) !== 91) { i++; continue; }
    const labelEnd = scanLinkLabel(src, i);
    if (labelEnd === -1) { i++; continue; }
    const after = labelEnd;
    if (after < n && src.charCodeAt(after) === 40) { i++; continue; }
    const labelText = src.slice(i + 1, labelEnd - 1);
    if (after < n && src.charCodeAt(after) === 91) {
      if (after + 1 < n && src.charCodeAt(after + 1) === 93) { i = after + 2; continue; }
      const refEnd = scanMaskRef(src, after);
      if (refEnd === -1) { i++; continue; }
      const key = normalizeLabel(src.slice(after + 1, refEnd - 1));
      if (!key.length || !refs.has(key)) { i++; continue; }
      // A full reference whose label holds a link is not itself a link
      // (marked's linkInText): mask only the [ref] part and keep the
      // label visible (with its inner reference links masked), so
      // emphasis inside the label can still form.
      if (labelHasLink(labelText, refs)) {
        const maskedLabel = maskReflinks(labelText, refs);
        for (let k = 0; k < maskedLabel.length; k++) ch[i + 1 + k] = maskedLabel[k];
        for (let k = after + 1; k < refEnd - 1; k++) ch[k] = 'a';
        i = refEnd;
        continue;
      }
      maskBlank(ch, i, refEnd);
      i = refEnd;
      continue;
    }
    const key = normalizeLabel(labelText);
    if (!key.length || !refs.has(key)) { i++; continue; }
    maskBlank(ch, i, labelEnd);
    i = labelEnd;
  }
  return ch.join('');
}

// The masked copy of an inline text (same length as src): resolving
// reference links, escaped punctuation and code-span interiors, then
// inline links / code spans / HTML are replaced by placeholders.
function inlineMask(src, refs) {
  let t = src;
  if (refs.size > 0 && src.indexOf('[') !== -1) t = maskReflinks(t, refs);
  t = t.replace(MASK_PUNCT_RE, (m, s, r) => r ? '+'.repeat(m.length) : s ? s + m.slice(s.length, -s.length).replace(/`/g, '+') + s : m);
  t = t.replace(MASK_BLOCK_SKIP_RE, (m) => '[' + 'a'.repeat(Math.max(0, m.length - 2)) + ']');
  return t;
}

function parseInlineNodes(src, refs, inLabel) {
  const n = src.length;
  // A phantom code span needs a link label holding a backtick and a later
  // backtick; without both, the mask cannot hide any delimiter.
  const masked = (src.indexOf('`') !== -1 && src.indexOf('[') !== -1) ? inlineMask(src, refs) : null;
  let nodes = [];
  let textStart = 0;
  let lastHtml = false;
  let i = 0;
  // Inside a link label, '_' emphasis does not form around a code span
  // whose content contains a backtick (marked quirk).
  const noUnderscoreEm = inLabel && hasBacktickCodeSpan(src);
  // When a link attempt fails after scanning a label that contains a
  // backtick code span, '_' emphasis is suppressed inside that label
  // span (marked parses the label during the attempt and the '_' does
  // not recover). Only when a link was actually attempted: the ']'
  // must be followed by '(' or '['.
  const noUndRanges = [];
  // Emitted delimiter runs (position, length, char, canOpen, canClose) and
  // the end position of the most recent delimiter node.
  let delims = [];
  let delimEndPos = -1;
  const flush = (upto) => {
    if (upto > textStart) {
      nodes.push({ t: 0, s: src.slice(textStart, upto) });
      delimEndPos = -1;
    }
    lastHtml = false;
  };
  const pushNode = (nd) => {
    nodes.push(nd);
    delimEndPos = -1;
  };
  // Try an extended email autolink starting at the local-part run at `i`.
  // Returns true if one was emitted (and advanced `i` / `textStart`).
  // Inside a link label no email autolink forms (the address stays plain
  // text and does not block the outer link).
  const tryEmailAt = () => {
    if (inLabel) return false;
    if (inLinkDoc) return false;
    if (!isLocalCh(src.charCodeAt(i))) return false;
    if (i > 0 && isLocalCh(src.charCodeAt(i - 1)) && delimEndPos !== i) return false;
    // whether an open '_' emphasis delimiter precedes this email, so a
    // trailing '_' after its domain can close that emphasis instead of
    // breaking the match
    let hasOpenUnderscore = false;
    for (let d = delims.length - 1; d >= 0; d--) {
      if (delims[d].ch === '_' && delims[d].o) { hasOpenUnderscore = true; break; }
    }
    const r = emailForward(src, i, hasOpenUnderscore);
    if (!r) return false;
    if (src.charCodeAt(i) === 95 && underscoreEmAt(src, i, r.at)) return false;
    // The local part must not cross a '_' that closes an emphasis pair
    // opened by an already-emitted delimiter (e.g. `_a_@b.c`: the email
    // `a_@b.c` must not form inside the em `_a_`).
    for (let k = i; k < r.at; k++) {
      if (src.charCodeAt(k) !== 95) continue;
      let m = k;
      while (m < r.at && src.charCodeAt(m) === 95) m++;
      const info = delimInfo(src, k, m);
      const canClose = info.rightFlanking && (!info.leftFlanking || info.nextPunct);
      if (!canClose) { k = m - 1; continue; }
      // nearest emitted '_' opener before k
      let openPos = -1;
      for (let d = delims.length - 1; d >= 0; d--) {
        if (delims[d].ch === '_' && delims[d].o && delims[d].pos < k) {
          openPos = delims[d].pos;
          break;
        }
      }
      if (openPos === -1) { k = m - 1; continue; }
      // is that opener already closed by an emitted '_' closer?
      let closed = false;
      for (let d = delims.length - 1; d >= 0; d--) {
        if (delims[d].ch === '_' && delims[d].c && delims[d].pos > openPos && delims[d].pos < k) {
          closed = true;
          break;
        }
      }
      if (!closed) return false;
      k = m - 1;
    }
    flush(i);
    pushNode({ t: 2, h: r.href, ti: null, ch: [{ t: 0, s: r.text }] });
    i = r.end;
    textStart = i;
    lastHtml = false;
    return true;
  };
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) {
      // backslash escape / hard break
      if (i + 1 < n) {
        const d = src.charCodeAt(i + 1);
        if (d === 10) {
          if (i + 2 < n) {
            flush(i);
            pushNode({ t: 5 });
            i += 2;
            // the next line's leading spaces/tabs are stripped after a
            // hard break
            while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
            textStart = i;
            continue;
          }
          i++;
          continue;
        }
        if (isAsciiPunct(d)) {
          flush(i);
          pushNode({ t: 0, s: src[i + 1] });
          i += 2;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 96) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const run = j - i;
      const close = findCodeClose(src, j, run);
      if (close !== -1) {
        flush(i);
        let content = src.slice(j, close).replace(/\n/g, ' ');
        if (
          content.length >= 2 && content[0] === ' ' &&
          content[content.length - 1] === ' ' && content.trim() !== ''
        ) content = content.slice(1, -1);
        pushNode({ t: 1, s: content });
        i = close + run;
        textStart = i;
        lastHtml = false;
        continue;
      }
      i = j;
      continue;
    }
    if (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91) {
      const r = tryLink(src, i + 1, refs, true);
      if (r) {
        flush(i);
        pushNode({ t: 3, s: r.href, ti: r.title, alt: plainText(r.ch) });
        i = r.end;
        textStart = i;
        lastHtml = false;
        continue;
      }
      i++;
      continue;
    }
    if (c === 91) {
      const r = tryLink(src, i, refs, false);
      if (r) {
        flush(i);
        pushNode({ t: 2, h: r.href, ti: r.title, ch: r.ch });
        i = r.end;
        textStart = i;
        lastHtml = false;
        continue;
      }
      // failed link attempt: if the label scan succeeds and a link
      // suffix follows, suppress '_' emphasis inside a label that
      // holds a code span with a backtick in it. Use a plain bracket
      // scan here: scanLinkLabel itself may reject the label over
      // backtick pairing, but the label span is still the span to
      // suppress.
      let le = -1;
      {
        let d = 0;
        let j = i;
        while (j < n) {
          const cc = src.charCodeAt(j);
          if (cc === 92) { j += 2; continue; }
          if (cc === 91) { d++; j++; continue; }
          if (cc === 93) { d--; if (d === 0) { le = j + 1; break; } j++; continue; }
          j++;
        }
      }
      if (le !== -1 && le < n && (src.charCodeAt(le) === 40 || src.charCodeAt(le) === 91) &&
          hasBacktickCodeSpan(src.slice(i + 1, le - 1))) {
        noUndRanges.push([i, le]);
      }
      i++;
      continue;
    }
    if (c === 60) {
      const a = tryAngle(src, i);
      if (a) {
        flush(i);
        // an angle autolink inside a label is a nested link (it does not
        // block the outer link); mark it so containsLink skips it
        pushNode({ t: 2, h: a.href, ti: null, ch: [{ t: 0, s: a.text }], a: 1 });
        i = a.end;
        textStart = i;
        lastHtml = false;
        continue;
      }
      const h = tryHtmlTag(src, i);
      if (h) {
        flush(i);
        pushNode({ t: 4, s: src.slice(i, h.end) });
        // an inline <a ...> tag opens the document-level inLink state
        // (GFM autolinks stop forming); </a> closes it. Tags inside a
        // link label do not touch it.
        if (!inLabel) {
          const tagText = src.slice(i, h.end);
          if (tagText.length >= 3 && tagText.charCodeAt(0) === 60 &&
              (tagText.charCodeAt(1) === 97 || tagText.charCodeAt(1) === 65) &&
              tagText.charCodeAt(2) === 32) {
            inLinkDoc = true;
          } else if (tagText.length >= 4 && tagText.charCodeAt(0) === 60 &&
              tagText.charCodeAt(1) === 47 &&
              (tagText.charCodeAt(2) === 97 || tagText.charCodeAt(2) === 65) &&
              tagText.charCodeAt(3) === 62) {
            inLinkDoc = false;
          }
        }
        i = h.end;
        textStart = i;
        lastHtml = true;
        continue;
      }
      i++;
      continue;
    }
    if (c === 42 || c === 95 || c === 126) {
      if (c === 95 && tryEmailAt()) continue;
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      const ch = src[i];
      const info = delimInfo(src, i, j);
      let canOpen;
      let canClose;
      if (ch === '_') {
        canOpen = info.leftFlanking && (!info.rightFlanking || info.prevPunct);
        canClose = info.rightFlanking && (!info.leftFlanking || info.nextPunct);
        if (noUnderscoreEm) { canOpen = false; canClose = false; }
        else if (noUndRanges.length > 0) {
          for (const rg of noUndRanges) {
            if (i >= rg[0] && i < rg[1]) { canOpen = false; canClose = false; break; }
          }
        }
      } else if (ch === '~' && j - i > 2) {
        // a run of three or more tildes can neither open nor close a
        // strikethrough
        canOpen = false;
        canClose = false;
      } else {
        canOpen = info.leftFlanking;
        canClose = info.rightFlanking;
      }
      // a delimiter hidden by the emphasis mask (inside a phantom code
      // span or other masked region) can neither open nor close
      if (masked && masked[i] !== src[i]) { canOpen = false; canClose = false; }
      flush(i);
      nodes.push({ t: 6, ch, len: j - i, o: canOpen, c: canClose });
      delims.push({ pos: i, len: j - i, ch, o: canOpen, c: canClose });
      delimEndPos = j;
      i = j;
      textStart = i;
      lastHtml = false;
      continue;
    }
    if (c === 104 || c === 72 || c === 102 || c === 70) {
      // a bare scheme URL does not form inside a link label, nor while
      // the document-level inLink state is set (unclosed <a> tag)
      const r = (!inLabel && !inLinkDoc) ? trySchemeUrl(src, i) : null;
      if (r) {
        flush(i);
        pushNode({ t: 2, h: r.href, ti: null, ch: [{ t: 0, s: r.text }] });
        i = r.end;
        textStart = i;
        lastHtml = false;
        continue;
      }
      if (tryEmailAt()) continue;
      i++;
      continue;
    }
    if (c === 119 || c === 87) {
      let ok = false;
      if (i === 0) ok = true;
      else if (lastHtml && textStart === i) ok = true;
      else {
        const p = src.charCodeAt(i - 1);
        ok = p === 32 || p === 9 || p === 10 || p === 11 || p === 12 ||
          p === 40 || p === 42 || p === 95 || p === 126;
      }
      if (ok) {
        // a www. autolink does not form inside a link label, nor while
        // the document-level inLink state is set (unclosed <a> tag)
        const r = (!inLabel && !inLinkDoc) ? tryWww(src, i) : null;
        if (r) {
          flush(i);
          pushNode({ t: 2, h: r.href, ti: null, ch: [{ t: 0, s: r.text }] });
          i = r.end;
          textStart = i;
          lastHtml = false;
          continue;
        }
      }
      if (tryEmailAt()) continue;
      i++;
      continue;
    }
    if (c === 109 || c === 77) {
      const prev = i === 0 ? 0 : src.charCodeAt(i - 1);
      if (i === 0 || !(isAlnum(prev) || prev === 95)) {
        // a mailto: autolink does not form inside a link label, nor
        // while the document-level inLink state is set (unclosed <a>)
        const r = (!inLabel && !inLinkDoc) ? tryMailto(src, i) : null;
        if (r) {
          flush(i);
          pushNode({ t: 2, h: r.href, ti: null, ch: [{ t: 0, s: r.text }] });
          i = r.end;
          textStart = i;
          lastHtml = false;
          continue;
        }
      }
      if (tryEmailAt()) continue;
      i++;
      continue;
    }
    if (c === 120 || c === 88) {
      const prev = i === 0 ? 0 : src.charCodeAt(i - 1);
      if (i === 0 || !(isAlnum(prev) || prev === 95)) {
        // an xmpp: autolink does not form inside a link label, nor
        // while the document-level inLink state is set (unclosed <a>)
        const r = (!inLabel && !inLinkDoc) ? tryXmpp(src, i) : null;
        if (r) {
          flush(i);
          pushNode({ t: 2, h: r.href, ti: null, ch: [{ t: 0, s: r.text }] });
          i = r.end;
          textStart = i;
          lastHtml = false;
          continue;
        }
      }
      if (tryEmailAt()) continue;
      i++;
      continue;
    }
    if (c === 10) {
      // hard break: two or more trailing spaces in the pending text
      let k = i - 1;
      let spaces = 0;
      while (k >= textStart && src.charCodeAt(k) === 32) { spaces++; k--; }
      if (spaces >= 2) {
        flush(i - spaces);
        pushNode({ t: 5 });
        i++;
        // the next line's leading spaces/tabs are stripped after a
        // hard break
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        textStart = i;
        lastHtml = false;
        continue;
      }
      i++;
      continue;
    }
    if (tryEmailAt()) continue;
    i++;
  }
  flush(n);
  nodes = processEmphasis(nodes);
  return nodes;
}

// --- link reference definitions ---------------------------------------------
// Scan a link label in `text` starting at text[i] === '[' (may span lines).
// Returns the index just after ']' or -1.
function scanLabelText(text, i) {
  const n = text.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 91) { depth++; j++; continue; }
    if (c === 93) {
      depth--;
      if (depth === 0) return j + 1;
      j++;
      continue;
    }
    if (j - i > 999) return -1;
    j++;
  }
  return -1;
}

// Paren balance of the raw text in src[i..j): -2 when a '(' is never
// closed, the index of an unmatched ')' when one is found, -1 when balanced.
function parenBalance(src, i, j) {
  let depth = 0;
  let k = i;
  while (k < j) {
    const c = src.charCodeAt(k);
    if (c === 92) { k += 2; continue; }
    if (c === 40) depth++;
    else if (c === 41) {
      depth--;
      if (depth < 0) return k;
    }
    k++;
  }
  if (depth > 0) return -2;
  return -1;
}

// Parse one link reference definition at the start of a line in `text`
// (pos is at the line start, or 0). Returns {label, dest, title, end} or
// null; `end` is just after the newline that ends the definition. The
// label is strict (no nested brackets, no < > or backticks, not blank);
// the destination may sit on the next line; a title must be preceded by
// whitespace and may sit on the next line; a title on the next line with
// junk after it is dropped and the definition ends after the destination.
function parseRefDef(text, pos) {
  const n = text.length;
  let i = pos;
  let spaces = 0;
  while (i < n && text.charCodeAt(i) === 32 && spaces < 4) { spaces++; i++; }
  if (spaces >= 4) return null;
  if (i >= n || text.charCodeAt(i) !== 91) return null;
  const labelEnd = scanRefLabel(text, i);
  if (labelEnd === -1) return null;
  const label = text.slice(i + 1, labelEnd - 1);
  if (normalizeLabel(label).length === 0) return null;
  let j = labelEnd;
  if (j >= n || text.charCodeAt(j) !== 58) return null;
  j++;
  // skip spaces/tabs and at most one newline before the destination
  let k = j;
  while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
  if (k < n && text.charCodeAt(k) === 10) {
    k++;
    while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
  }
  if (k >= n) return null;
  const destStart = k;
  const d = parseDest(text, k);
  if (!d) return null;
  // a bare destination with an unbalanced paren is not a definition
  if (text.charCodeAt(destStart) !== 60 && parenBalance(text, destStart, d.end) !== -1) return null;
  j = d.end;
  // optional title: it must be separated from the destination by
  // whitespace (spaces/tabs on the same line, or a newline)
  let title = null;
  let titleEnd = -1;
  let titleOnLaterLine = false;
  k = j;
  let spacesAfterDest = 0;
  while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) { k++; spacesAfterDest++; }
  if (k < n && (text.charCodeAt(k) === 34 || text.charCodeAt(k) === 39 || text.charCodeAt(k) === 40) && spacesAfterDest > 0) {
    const t = parseTitle(text, k);
    if (t) { title = t.title; titleEnd = t.end; }
  } else if (k < n && text.charCodeAt(k) === 10) {
    // try a title on the next line
    let m = k + 1;
    while (m < n && (text.charCodeAt(m) === 32 || text.charCodeAt(m) === 9)) m++;
    if (m < n && (text.charCodeAt(m) === 34 || text.charCodeAt(m) === 39 || text.charCodeAt(m) === 40)) {
      const t = parseTitle(text, m);
      if (t) { title = t.title; titleEnd = t.end; titleOnLaterLine = true; }
    }
  }
  if (title !== null) {
    // the rest of the title's line must be blank
    let e = titleEnd;
    while (e < n && (text.charCodeAt(e) === 32 || text.charCodeAt(e) === 9)) e++;
    if (e < n && text.charCodeAt(e) !== 10) {
      if (!titleOnLaterLine) return null;
      title = null;
      titleEnd = -1;
    }
  }
  if (title !== null) {
    const end = titleEnd < n && text.charCodeAt(titleEnd) === 10 ? titleEnd + 1 : titleEnd;
    return { label, dest: d.dest, title, end };
  }
  // no title: the rest of the destination's line must be blank
  let e = j;
  while (e < n && (text.charCodeAt(e) === 32 || text.charCodeAt(e) === 9)) e++;
  if (e < n && text.charCodeAt(e) !== 10) return null;
  const end = e < n ? e + 1 : e;
  return { label, dest: d.dest, title: null, end };
}

// Extract leading link reference definitions from paragraph text.
// Definitions only occur at the start of a paragraph (or after other
// definitions); once ordinary text appears, no more are taken. Returns
// the remaining text ('' when the paragraph was only definitions).
function extractRefDefs(text, refs) {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    const r = parseRefDef(text, pos);
    if (!r) break;
    const key = normalizeLabel(r.label);
    if (!refs.has(key)) refs.set(key, { dest: r.dest, title: r.title });
    pos = r.end;
  }
  // strip the leading newlines of the remainder
  let rest = text.slice(pos);
  rest = rest.replace(/^\n+/, '');
  return rest;
}

// --- block parsing ----------------------------------------------------------
// Does `s` start a block that can interrupt a paragraph? Returns the kind
// ('atx' | 'fence' | 'html' | 'hr' | 'list' | 'setext' | 'table') or null.
// (setext/table are only relevant with a paragraph leaf; the caller checks.)
function interruptingBlock(s, para, col0, inItem) {
  if (matchQuote(s, col0) !== null) return 'quote';
  if (parseAtx(s, col0)) return 'atx';
  if (parseFence(s, col0)) return 'fence';
  const ht = htmlBlockType(s, col0);
  if (ht !== 0 && !(para && ht === 7)) return 'html';
  if (parseThematicBreak(s, col0)) return 'hr';
  const lm = parseListMarker(s, col0);
  if (lm) {
    if (!para) return 'list';
    // inside a list item any ordered marker interrupts the paragraph
    // and starts a nested list, whatever its start number is; elsewhere
    // an ordered list can only interrupt when it starts with 1
    if (!lm.ordered || lm.start === 1 || inItem) return 'list';
  }
  return null;
}

function parseBlocks(md, refs) {
  const lines = md.split('\n');
  const mdEndsWithNl = md.length > 0 && md.charCodeAt(md.length - 1) === 10;
  if (mdEndsWithNl) lines.pop();
  const doc = { t: 'doc', ch: [] };
  const stack = [doc];
  let leaf = null;
  let blankBefore = false;
  // a raw blank line (not one that is blank only after stripping its
  // container markers) preceded the current line; only a raw blank line
  // between items makes a list loose
  let blankBeforeRaw = false;
  // the innermost container a blank-after-strip line belonged to; a
  // blank line inside a quote loosens only lists nested in that quote,
  // never a list outside it
  let blankContainer = null;

  const cur = () => stack[stack.length - 1];

  // What follows the line at index `idx` in the current container
  // context: 0 = a blank line, 1 = a content line in the same containers,
  // 2 = the next line fails a container (the block is cut off).
  // Whether an HTML block of the given type keeps a trailing newline.
  // The block ends with '\n' when the next line in its container is a
  // following line. For marker-ended blocks (types 1-5: script, comment,
  // PI, doctype, CDATA) a whitespace-only next line still counts as a
  // following line (only a truly empty line, or a line that fails the
  // container, drops the newline). For blank-line-ended blocks (types
  // 6-7) a whitespace-only line is the ending blank line, so it drops it.
  const htmlTrailingNl = (idx, ht) => {
    if (idx >= lines.length) return mdEndsWithNl;
    let s2 = lines[idx];
    for (let d = 1; d < stack.length; d++) {
      const fr = stack[d];
      if (fr.t === 'quote') {
        const m = matchQuote(s2);
        if (m === null) return false;
        s2 = m.rest;
      } else if (fr.t === 'item') {
        if (indentCols(s2) < fr.contentIndent) return false;
        s2 = stripCols(s2, fr.contentIndent);
      }
    }
    if (ht >= 1 && ht <= 5) return s2.length > 0;
    return s2.trim() !== '';
  };
  const nextLineKind = (idx) => {
    if (idx >= lines.length) return 2;
    let s2 = lines[idx];
    if (isBlank(s2)) return 0;
    for (let d = 1; d < stack.length; d++) {
      const fr = stack[d];
      if (fr.t === 'quote') {
        const m = matchQuote(s2);
        if (m === null) return 2;
        s2 = m;
      } else if (fr.t === 'item') {
        if (indentCols(s2) < fr.contentIndent) return 2;
        s2 = stripCols(s2, fr.contentIndent);
      }
    }
    return s2.trim() === '' ? 0 : 1;
  };

  const finalizeLeaf = () => {
    if (!leaf) return;
    if (leaf.t === 'html' && leaf.trailingNl === undefined) {
      // a block still open at the end of the input: it keeps the
      // input's trailing newline, if any
      leaf.trailingNl = mdEndsWithNl;
    }
    if (leaf.t === 'para') {
      const text = leaf.lines.join('\n');
      const rest = extractRefDefs(text, refs);
      const parent = cur();
      if (rest.trim() === '') {
        const idx = parent.ch.indexOf(leaf);
        if (idx !== -1) parent.ch.splice(idx, 1);
      } else {
        leaf.text = rest;
      }
    } else if (leaf.t === 'code' && !leaf.fenced) {
      while (leaf.lines.length > 0 && leaf.lines[leaf.lines.length - 1] === '') leaf.lines.pop();
    }
    leaf = null;
  };

  const closeTo = (depth) => {
    finalizeLeaf();
    while (stack.length > depth) stack.pop();
  };

  // Mark the list owning the current item loose when a blank line
  // separates two blocks directly inside that item. Only fires when the
  // new block is added straight to the item: a blank line between two
  // items of an inner list must not loosen the outer list.
  const markLooseIfBlank = () => {
    if (!blankBefore) return;
    const parent = cur();
    if (parent.t !== 'item') return;
    if (parent.ch.length > 0) {
      const list = stack[stack.length - 2];
      if (list && list.t === 'list') list.tight = false;
    }
  };

  const addLeaf = (b) => {
    markLooseIfBlank();
    cur().ch.push(b);
    leaf = b;
  };

  // Replace the current leaf (a paragraph) in its parent with block `b`.
  const replaceLeaf = (b) => {
    const parent = cur();
    const idx = parent.ch.indexOf(leaf);
    if (idx !== -1) parent.ch[idx] = b;
    leaf = b;
  };

  for (let li = 0; li < lines.length; li++) {
    const rawLine = lines[li];
    const blank = isBlank(rawLine);
    // 1. Match the line against the open containers. sCol is the absolute
    // column of s[0]; a tab straddling a container boundary becomes
    // spaces, so later indent math uses the original columns.
    let s = rawLine;
    let sCol = 0;
    let failedAt = -1;
    // the column just before the innermost blockquote marker was
    // stripped; a tab's effective column is measured as if only the
    // outer blockquotes were stripped (the innermost marker still
    // counts). List-item indents do not shift the tab column.
    let outerCol = 0;
    // the innermost container whose marker was actually stripped on
    // this line (a quote or an item); a blank-after-strip line belongs
    // to this container
    let lastStripped = null;
    if (!blank) {
      for (let d = 1; d < stack.length; d++) {
        const fr = stack[d];
        if (fr.t === 'quote') {
          const m = matchQuote(s, sCol);
          if (m === null) { failedAt = d; break; }
          outerCol = sCol;
          lastStripped = fr;
          s = m.rest;
          sCol = m.col;
        } else if (fr.t === 'item') {
          // an empty item followed by a blank line is closed: the next
          // line is not its content
          if (fr.ch.length === 0 && blankBefore) { failedAt = d; break; }
          if (indentCols(s, sCol) < fr.contentIndent) { failedAt = d; break; }
          lastStripped = fr;
          s = stripCols(s, fr.contentIndent, sCol);
          sCol = sCol + fr.contentIndent;
        }
        // a list frame consumes nothing
      }
      // A tab left at the start of a line that went through container
      // stripping expands to spaces from its effective column.
      if (stack.length > 1) {
        s = expandTabInIndent(s, sCol, outerCol);
      }
    }
    // 1b. A line that is blank after stripping its container markers.
    // When it strips to nothing it is a blank line (the containers
    // matched, so they stay open). When it still holds whitespace it
    // continues a paragraph as a whitespace line. But when an inner
    // BLOCKQUOTE failed, the line is not content of the leaf inside
    // that quote: a blank-after-strip line does not keep a fenced
    // code block or a paragraph open across a quote boundary (the
    // '>' line that ends an inner blockquote). Close the failed quote
    // first, then treat the line as blank in the reduced context; the
    // raw line is not blank, so blankBeforeRaw stays false. A failed
    // LIST ITEM is different: a blank line never closes a list item,
    // so it falls through to the normal blank handling and stays open.
    if (!blank && s.trim() === '') {
      if (failedAt !== -1 && stack[failedAt] && stack[failedAt].t === 'quote') {
        // The line failed an inner BLOCKQUOTE but stripped to blank: it
        // is not content of the leaf inside that quote (a blank-after-
        // strip line does not keep a fenced code block or a paragraph
        // open across a quote boundary; the '>' line that ends an inner
        // blockquote). Close the failed quote first, then treat the line
        // as blank in the reduced context; the raw line is not blank,
        // so blankBeforeRaw stays false. A failed LIST ITEM is different:
        // a blank line never closes a list item, so it falls through to
        // the normal blank handling below and the item stays open.
        if (leaf && leaf.t === 'html' && leaf.trailingNl === undefined) leaf.trailingNl = false;
        closeTo(failedAt);
        blankBefore = true;
        blankBeforeRaw = false;
        blankContainer = lastStripped;
        continue;
      }
      if (s !== '' && leaf && leaf.t === 'para') {
        leaf.lines.push(s);
        blankBefore = false;
        continue;
      }
      if (leaf && leaf.t === 'code') {
        if (leaf.fenced) leaf.lines.push(stripFenceIndent(s, leaf.fence.indentChars));
        else if (indentCols(s, sCol) >= 4) leaf.lines.push(stripCols(s, 4, sCol));
        else leaf.lines.push('');
      } else if (leaf && leaf.t === 'html' && leaf.htmlType >= 1 && leaf.htmlType <= 5) {
        leaf.lines.push('');
      } else if (leaf && (leaf.t === 'para' || leaf.t === 'table' || leaf.t === 'html')) {
        if (leaf.t === 'html') leaf.trailingNl = false;
        finalizeLeaf();
      }
      blankBefore = true;
      blankContainer = lastStripped;
      continue;
    }
    // 2. Lazy continuation: a paragraph inside a container can continue
    // on a line that lacks the container marker, unless the line starts
    // a block. Interrupting blocks are checked before setext (a '-'
    // line is a list marker, not a setext underline). A lazy setext
    // underline stays as paragraph text, with four spaces prepended
    // when the paragraph already has two or more lines (a single-line
    // paragraph keeps it as-is). Any other lazy line loses 4 columns
    // of leading whitespace when it has at least 4. (A table delimiter
    // outside the container is not a delimiter at all, so it stays as
    // paragraph text too.)
    if (failedAt !== -1 && leaf && leaf.t === 'para' && !blank) {
      // A list marker ends the lazy paragraph and starts a new item,
      // even an ordered one that does not start with 1: the paragraph
      // is already ending by container failure, so the "a list can only
      // interrupt a paragraph when it starts with 1" rule does not apply.
      if (parseListMarker(s, sCol)) {
        // fall through to close the containers and start the new block
      } else if (!interruptingBlock(s, true, sCol)) {
        let text = s;
        const st = parseSetext(s, sCol);
        if (st !== 0 && leaf.lines.length >= 2) text = '    ' + s;
        else if (st === 0 && indentCols(s, sCol) >= 4) text = stripCols(s, 4, sCol);
        leaf.lines.push(text);
        blankBefore = false;
        blankBeforeRaw = false;
        continue;
      }
    }
    // 2b. A fenced code block swallows a line that fails a LIST ITEM
    // container: the line is code content, not the end of the block
    // (e.g. a line at column 0 inside a fenced block in a list item).
    // A line that fails a BLOCKQUOTE does end the quote (and the code
    // block inside it), so only an item failure is swallowed. But only
    // a PLAIN line is swallowed: a line that starts a new block (a list
    // marker, an ATX heading, a fence, a thematic break, a blockquote,
    // an HTML block) closes the containers instead, so the fence ends
    // and the line starts its block outside. (A closing fence at column
    // 0 is a fence, not code content; a setext underline is swallowed,
    // matching marked's code-content treatment of it.) But only once
    // the block already has content: if the FIRST line after the fence
    // fails the item, the fence closes empty and the line becomes a
    // paragraph outside the list.
    if (failedAt !== -1 && leaf && leaf.t === 'code' && leaf.fenced && !blank &&
        leaf.lines.length > 0 &&
        stack[failedAt] && stack[failedAt].t === 'item' &&
        !interruptingBlock(s, false, sCol)) {
      leaf.lines.push(stripFenceIndent(rawLine, leaf.fence.indentChars));
      blankBefore = false;
      blankBeforeRaw = false;
      continue;
    }
    // 3. Close containers that did not match.
    if (failedAt !== -1) {
      // a container failure cuts an open HTML block off without a
      // trailing newline
      if (leaf && leaf.t === 'html' && leaf.trailingNl === undefined) leaf.trailingNl = false;
      closeTo(failedAt);
    }

    if (blank) {
      // A raw blank line closes every open blockquote (from the outermost
      // one inward, keeping its parent, e.g. a list item). A blank line
      // after an HTML block strips the block's trailing newline, so the
      // flag is set before the quotes close (which finalizes the leaf) --
      // but only when the blank line actually ends the block: a type 6-7
      // block, or a block inside a quote that is being closed. A blank
      // line inside a type 1-5 block is content, not an ending.
      const hasQuote = stack.some((fr) => fr.t === 'quote');
      if (leaf && leaf.t === 'html' && (leaf.htmlType >= 6 || hasQuote)) leaf.trailingNl = false;
      for (let d = 1; d < stack.length; d++) {
        if (stack[d].t === 'quote') { closeTo(d); break; }
      }
      if (leaf && leaf.t === 'code') {
        // A whitespace-only line inside code keeps its spaces minus the
        // code indent (indented code: 4 columns; fenced code: the fence
        // indent). At the top level the raw line is the content line.
        if (stack.length === 1) {
          if (leaf.fenced) leaf.lines.push(stripFenceIndent(rawLine, leaf.fence.indentChars));
          else if (indentCols(rawLine) >= 4) leaf.lines.push(stripCols(rawLine, 4));
          else leaf.lines.push('');
        } else {
          leaf.lines.push('');
        }
      } else if (leaf && leaf.t === 'html' && leaf.htmlType >= 1 && leaf.htmlType <= 5) {
        leaf.lines.push('');
      } else if (leaf && leaf.t === 'table' && rawLine.length > 0) {
        // A whitespace-only line is a table row (of empty cells) only
        // when it holds a tab that expands to exactly four columns
        // (e.g. a lone tab); any other whitespace-only line (spaces,
        // empty, or a tab expanding past four columns) ends the table.
        if (rawLine.indexOf('\t') !== -1 && indentCols(rawLine) === 4) {
          const cells = splitTableCells(s);
          leaf.rows.push(cells === null ? [s] : cells);
          blankBefore = false;
          blankBeforeRaw = false;
          continue;
        }
        finalizeLeaf();
      } else if (leaf && (leaf.t === 'para' || leaf.t === 'table' || leaf.t === 'html')) {
        // a blank line after an HTML block strips its trailing newline
        if (leaf.t === 'html') leaf.trailingNl = false;
        finalizeLeaf();
      }
      blankBefore = true;
      blankBeforeRaw = true;
      blankContainer = null;
      continue;
    }

    // 4. Process the (non-blank) line in the current container.
    // restCol is the absolute column of rest[0].
    let rest = s;
    let restCol = sCol;
    while (true) {
      // Fenced code: check for the closing fence, else append the line.
      if (leaf && leaf.t === 'code' && leaf.fenced) {
        if (isFenceClose(rest, leaf.fence, restCol)) {
          finalizeLeaf();
        } else {
          leaf.lines.push(stripFenceIndent(rest, leaf.fence.indentChars));
        }
        break;
      }
      // Indented code: continues while indented >= 4.
      if (leaf && leaf.t === 'code' && !leaf.fenced) {
        if (indentCols(rest, restCol) >= 4) {
          leaf.lines.push(stripCols(rest, 4, restCol));
          break;
        }
        finalizeLeaf();
        // fall through to start a new block
      }
      // HTML block: check the end condition, else append.
      if (leaf && leaf.t === 'html') {
        leaf.lines.push(rest);
        if (htmlEndMarker(rest, leaf.htmlType, leaf.htmlTag)) {
          // the block keeps a trailing newline per its type (see
          // htmlTrailingNl): marker-ended blocks keep it after a
          // whitespace-only line, blank-line-ended ones do not
          if (li + 1 < lines.length) leaf.trailingNl = htmlTrailingNl(li + 1, leaf.htmlType);
          else leaf.trailingNl = mdEndsWithNl;
          finalizeLeaf();
        }
        break;
      }
      // Table: a further row, else the table ends. Any non-blank line
      // that does not start another block is a row, even without a pipe.
      if (leaf && leaf.t === 'table') {
        if (!interruptingBlock(rest, false, restCol)) {
          const cells = splitTableCells(rest);
          leaf.rows.push(cells === null ? [rest] : cells);
          break;
        }
        finalizeLeaf();
        // fall through to start a new block
      }
      // Paragraph: setext, table delimiter, interrupting block, or continue.
      if (leaf && leaf.t === 'para') {
        const st = parseSetext(rest, restCol);
        if (st !== 0) {
          // definitions are extracted first: they do not belong in the
          // heading, and a paragraph that was only definitions is no
          // heading at all (the setext line becomes paragraph text)
          const text = leaf.lines.join('\n');
          const restText = extractRefDefs(text, refs);
          if (restText.trim() === '') {
            const parent = cur();
            const idx = parent.ch.indexOf(leaf);
            if (idx !== -1) parent.ch.splice(idx, 1);
            leaf = null;
          } else {
            const headingText = restText.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
            replaceLeaf({ t: 'heading', level: st, text: headingText });
            leaf = null;
            break;
          }
        }
        if (leaf) {
          if (leaf.lines.length === 1) {
            const aligns = parseTableDelimiter(rest);
            // the delimiter must have as many cells as the header row
            if (aligns !== null && aligns.length === splitTableCells(leaf.lines[0]).length) {
              const head = splitTableCells(leaf.lines[0]);
              replaceLeaf({ t: 'table', head, aligns, rows: [] });
              break;
            }
          }
          // an empty list item cannot interrupt a paragraph
          const lmPara = parseListMarker(rest, restCol);
          if (lmPara && lmPara.empty) {
            leaf.lines.push(rest);
            break;
          }
          if (interruptingBlock(rest, true, restCol, cur().t === 'item')) {
            finalizeLeaf();
            // fall through to start the new block
          } else {
            leaf.lines.push(rest);
            break;
          }
        }
      }
      // No current leaf: start a new block. A non-list block cannot be
      // a direct child of a list: close it. (A thematic break wins over
      // a list marker: '* * *' is an <hr>.)
      if (cur().t === 'list' && (!parseListMarker(rest, restCol) || parseThematicBreak(rest, restCol))) closeTo(stack.length - 1);
      // A new block inside a list item marks the list loose when a blank
      // line preceded it (this covers lists and quotes, which are created
      // directly here rather than through addLeaf). Runs after the list
      // above is closed, so the block's parent item is current.
      markLooseIfBlank();
      const qm = matchQuote(rest, restCol);
      if (qm !== null) {
        const quote = { t: 'quote', ch: [] };
        cur().ch.push(quote);
        stack.push(quote);
        if (qm.rest === '') break;
        rest = qm.rest;
        restCol = qm.col;
        continue;
      }
      const atx = parseAtx(rest, restCol);
      if (atx) {
        addLeaf({ t: 'heading', level: atx.level, text: atx.text });
        leaf = null;
        break;
      }
      const fence = parseFence(rest, restCol);
      if (fence) {
        addLeaf({ t: 'code', fenced: true, info: fence.info, fence, lines: [] });
        break;
      }
      const ht = htmlBlockType(rest, restCol);
      if (ht !== 0) {
        const tag = ht === 1 ? htmlType1Tag(rest) : null;
        const b = { t: 'html', htmlType: ht, htmlTag: tag, lines: [rest] };
        addLeaf(b);
        // Types 1-5 end when the line already holds the end marker.
        // Types 6-7 stay open until a blank line.
        if (ht >= 1 && ht <= 5 && htmlEndMarker(rest, ht, tag)) {
          // the block keeps a trailing newline per its type (see
          // htmlTrailingNl): marker-ended blocks keep it after a
          // whitespace-only line, blank-line-ended ones do not
          if (li + 1 < lines.length) b.trailingNl = htmlTrailingNl(li + 1, ht);
          else b.trailingNl = mdEndsWithNl;
          leaf = null;
        }
        break;
      }
      if (parseThematicBreak(rest, restCol)) {
        addLeaf({ t: 'hr' });
        leaf = null;
        break;
      }
      const lm = parseListMarker(rest, restCol);
      if (lm) {
        // The marker identity: bullet char, or '.' / ')' for ordered lists.
        const nonSpace = firstNonSpace(rest);
        let marker;
        if (lm.ordered) {
          let k = nonSpace;
          while (k < rest.length && isDigit(rest.charCodeAt(k))) k++;
          marker = rest[k];
        } else {
          marker = rest[nonSpace];
        }
        // Find or create the list in the current container.
        let list = null;
        if (cur().t === 'list') {
          const curList = cur();
          if (lm.ordered === curList.ordered && marker === curList.marker) list = curList;
          else closeTo(stack.length - 1);
        }
        if (!list) {
          list = { t: 'list', ordered: lm.ordered, start: lm.start, marker, tight: true, items: [] };
          cur().ch.push(list);
          stack.push(list);
        }
        // Task list checkbox at the start of the item content.
        let content = listItemContent(rest, lm, restCol);
        let task = null;
        if (!lm.empty) {
          const tm = /^\[( |x|X)\](?:[ \t]|$)/.exec(content);
          if (tm) {
            task = tm[1] === ' ' ? ' ' : 'x';
            content = content.slice(tm[0].length);
            if (content.charCodeAt(0) === 32 || content.charCodeAt(0) === 9) content = content.slice(1);
          }
        }
        // A blank line between items makes the list loose: a raw blank
        // line always does; a blank line inside a container (e.g. a `>`
        // line in a quote) does so only for lists nested in that
        // container, never for a list outside it.
        if (list.items.length > 0) {
          if (blankBeforeRaw) list.tight = false;
          else if (blankBefore && blankContainer) {
            const bi = stack.indexOf(blankContainer);
            const li = stack.indexOf(list);
            if (bi !== -1 && li !== -1 && bi < li) list.tight = false;
          }
        }
        const item = { t: 'item', contentIndent: lm.contentIndent, task, ch: [] };
        list.items.push(item);
        stack.push(item);
        if (lm.empty) break;
        rest = content;
        restCol = restCol + lm.contentIndent;
        continue;
      }
      if (indentCols(rest, restCol) >= 4) {
        addLeaf({ t: 'code', fenced: false, info: '', lines: [stripCols(rest, 4, restCol)] });
        break;
      }
      addLeaf({ t: 'para', lines: [rest] });
      break;
    }
    blankBefore = false;
    blankBeforeRaw = false;
    blankContainer = null;
  }
  closeTo(1);
  return doc;
}

// --- rendering --------------------------------------------------------------
const ALIGN_NAME = { l: 'left', c: 'center', r: 'right' };

function renderBlocks(blocks, refs, tight) {
  let out = '';
  for (const b of blocks) {
    if (b.t === 'para') {
      const text = b.text !== undefined ? b.text : b.lines.join('\n');
      // In a tight list a paragraph renders as bare inline content, with no
      // trailing newline; otherwise it is a <p> block ending in '\n'.
      if (tight) out += parseInline(text, refs);
      else out += '<p>' + parseInline(text, refs) + '</p>\n';
    } else if (b.t === 'heading') {
      out += '<h' + b.level + '>' + parseInline(b.text, refs) + '</h' + b.level + '>\n';
    } else if (b.t === 'code') {
      // The content is the lines joined with '\n'; one '\n' is appended
      // unless the content is empty or already ends with one (a trailing
      // blank line inside the fence supplies it).
      let content = b.lines.join('\n');
      if (content.length > 0 && !content.endsWith('\n')) content += '\n';
      if (b.fenced) {
        const lang = b.info ? unescapeBackslash(b.info.split(/\s+/)[0]) : '';
        out += '<pre><code' + (lang ? ' class="language-' + escapeText(lang) + '"' : '') + '>';
        out += escapeRaw(content);
        out += '</code></pre>\n';
      } else {
        out += '<pre><code>' + escapeRaw(content) + '</code></pre>\n';
      }
    } else if (b.t === 'html') {
      // A raw HTML block keeps a trailing newline only when the line
      // after it is not blank (tracked on the block while parsing).
      out += b.lines.join('\n');
      if (b.trailingNl) out += '\n';
    } else if (b.t === 'hr') {
      out += '<hr>\n';
    } else if (b.t === 'quote') {
      out += '<blockquote>\n' + renderBlocks(b.ch, refs, false) + '</blockquote>\n';
    } else if (b.t === 'list') {
      const tag = b.ordered ? 'ol' : 'ul';
      out += '<' + tag + (b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n';
      for (const item of b.items) {
        out += '<li>';
        if (item.task && !b.tight) {
          // In a loose list the checkbox belongs inside the item's first
          // paragraph, so it is prepended to that paragraph's text (the
          // inline parser renders it as raw HTML). In a tight list it
          // stays outside, before the bare inline content. When the
          // first block is not a paragraph, emit it outside as usual.
          const first = item.ch[0];
          if (first && first.t === 'para') {
            const cb = item.task === 'x'
              ? '<input checked="" disabled="" type="checkbox"> '
              : '<input disabled="" type="checkbox"> ';
            if (first.text !== undefined) first.text = cb + first.text;
            else first.lines[0] = cb + first.lines[0];
          } else {
            out += item.task === 'x'
              ? '<input checked="" disabled="" type="checkbox"> '
              : '<input disabled="" type="checkbox"> ';
          }
        } else if (item.task) {
          out += item.task === 'x'
            ? '<input checked="" disabled="" type="checkbox"> '
            : '<input disabled="" type="checkbox"> ';
        }
        let inner = renderBlocks(item.ch, refs, b.tight);
        out += inner + '</li>\n';
      }
      out += '</' + tag + '>\n';
    } else if (b.t === 'table') {
      const cols = b.head.length;
      out += '<table>\n<thead>\n<tr>\n';
      for (let j = 0; j < cols; j++) {
        const a = b.aligns[j];
        out += '<th' + (a ? ' align="' + ALIGN_NAME[a] + '"' : '') + '>' +
          parseInline(b.head[j].trim(), refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length > 0) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let j = 0; j < cols; j++) {
            const a = b.aligns[j];
            const cell = j < row.length ? row[j].trim() : '';
            out += '<td' + (a ? ' align="' + ALIGN_NAME[a] + '"' : '') + '>' +
              parseInline(cell, refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
    }
  }
  return out;
}

export function parse(markdown) {
  inLinkDoc = false;
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = new Map();
  const doc = parseBlocks(src, refs);
  const html = renderBlocks(doc.ch, refs, false);
  return html;
}
