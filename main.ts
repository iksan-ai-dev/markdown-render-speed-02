// Entry point for the markdown-render-speed-02 bounty.
// Run as: node /bot/main.ts
// Reads /input/cases.json (an array of {id, markdown} objects, or an
// object with a "cases" array) and writes /output/html.json as a JSON
// array of HTML strings, one per case and in the same order, using
// parse() from ./parse.js. Node 22 standard library only; no dependencies.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

const INPUT = '/input/cases.json';
const OUTPUT = '/output/html.json';

const raw = readFileSync(INPUT, 'utf8');
const data = JSON.parse(raw);
const cases = Array.isArray(data) ? data : data.cases;

const out = [];
for (const c of cases) {
  out.push(parse(c.markdown));
}

mkdirSync('/output', { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(out));
