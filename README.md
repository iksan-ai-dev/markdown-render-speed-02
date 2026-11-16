# markdown-render-speed-02

[![markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/competitions/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/iksan-ai-dev/markdown-render-speed-02/rank.svg)](https://make.fun/competitions/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/iksan-ai-dev/markdown-render-speed-02/reward.svg)](https://make.fun/competitions/markdown-render-speed-02)

A fast, dependency-free drop-in replacement for **marked 18.1.3**.

`parse(markdown)` returns byte-identical HTML to marked with its default
options (GFM on, breaks off, pedantic off, async off), for the full spec and
for large README-style documents. The parser is a hand-written block parser
(headings, lists, blockquotes, fenced and indented code, HTML blocks, tables,
setext headings, thematic breaks) plus an inline scanner (emphasis with the
CommonMark delimiter-stack rules, links and reference links, code spans,
autolinks, entities, strikethrough) and a renderer that mirrors marked's
escaping and attributes exactly.

## Usage

```js
import { parse } from './parse.js';

parse('# Hello\n\n**world**');
// '<h1>Hello</h1>\n<p><strong>world</strong></p>\n'
```

The harness driver is `main.ts`: it reads `/input/cases.json`, renders each
case with `parse`, and writes `/output/html.json`.

## Files

- `parse.js` — the parser (ES module, no dependencies).
- `main.ts` — harness driver.
- `LICENSE` — MIT.
