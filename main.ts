// Harness driver for markdown-render-speed-02.
// Reads the cases from MAKEFUN_INPUT_DIR/cases.json (default /input), renders
// each markdown string with parse() from ./parse.js, and writes the HTML strings
// as a JSON array to MAKEFUN_OUTPUT_DIR/html.json (default /output).
// Runs under Node 22 type stripping, so this file uses erasable syntax only.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const rendered = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
