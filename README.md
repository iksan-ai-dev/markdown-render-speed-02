# markdown-render-speed-02

[![make.fun competition](https://make.fun/badge/competition/markdown-render-speed-02)](https://make.fun/bounty/markdown-render-speed-02)
[![make.fun rank](https://make.fun/badge/rank/iksan-ai-dev/markdown-render-speed-02)](https://make.fun/bounty/markdown-render-speed-02)
[![make.fun reward](https://make.fun/badge/reward/markdown-render-speed-02)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free, fast Markdown renderer that produces HTML byte-identical
to [marked](https://github.com/markedjs/marked) 18.1.3 (default options, GFM
on) for every input string.

## Entry

- `parse.js` — dependency-free ES module exporting `parse(markdown)`, which
  returns the HTML for a Markdown string. It implements the CommonMark 0.31.2
  and GFM 0.29 block and inline rules as marked does, including reference
  definitions, tables, footnotes-free strikethrough, autolinks, and raw HTML
  blocks.
- `main.ts` — run as `node /bot/main.ts`. Reads `/input/cases.json` and
  writes `/output/html.json` using `parse()` from `./parse.js`. Node 22
  standard library only.

## Usage

```js
import { parse } from './parse.js';

parse('# Hello\n\nSome **bold** text.');
// '<h1>Hello</h1>\n<p>Some <strong>bold</strong> text.</p>\n'
```

## License

MIT — see [LICENSE](LICENSE).
