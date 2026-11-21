// main.ts — the program the harness runs: node /bot/main.ts (node22). It reads every case from /input/cases.json (a
// JSON array of {id, input}), answers each with run() from solve.js, and writes /output/answers.json: a JSON array of
// the answers, one per case, in the cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand
// in for /input and /output.
//
// Each answer is serialised as soon as it is computed and its rows are dropped, so peak live memory is one case's
// rows plus the output string, never every case's rows at once. The bytes written are exactly JSON.stringify's.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it (as the house driver
// does, and as the rules let an entry do too).
setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];

let out = '[';
for (let k = 0; k < cases.length; k++) {
  if (k > 0) out += ',';
  out += JSON.stringify(run(cases[k].input));
}
out += ']';
writeFileSync(join(OUTPUT_DIR, 'answers.json'), out);
