# csv-reader-speed-01 entry

A drop-in, dependency-free replacement for `readCsv` from **csv-reader 1.0.0**, written to return exactly the same
`{columns, rows, errors}` for every `{text, header}` input, but much faster.

## Files

- `solve.js` — ES module, no dependencies. Exports `run(input)` → `{columns, rows, errors}`.
- `main.ts` — the program the harness runs (`node /bot/main.ts`, node22). Reads every case from `/input/cases.json`
  (`[{id, input}]`), answers each with `run`, writes `/output/answers.json` (answers in case order). Outside a
  container, `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` stand in for `/input` / `/output`.

## What solve.js does

One left-to-right pass over the UTF-16 indices of the text, reproducing every behaviour of csv-reader 1.0.0:

- a single leading U+FEFF stripped; records end at LF or CRLF; a line with no characters is not a record;
- outside quotes a CR not followed by LF is dropped and reported as `stray_cr`;
- a quoted field runs to the next non-doubled quote; `""` inside is one quote; every CRLF or lone CR inside counts as
  one line and normalises to LF; anything after the closing quote up to the next comma or line break is appended
  verbatim (`quote_junk`); a never-closed quote is literal and the rest is re-read unquoted (`unterminated_quote`);
- quotes inside an unquoted field are literal characters; fields stay strings, never trimmed or converted;
- `columns` is the first record when `header` is true, else null; later records are padded (`short_row`, with `fields`)
  or trimmed (`long_row`, with `extra`) to the first record's width;
- errors are `{code, line, row}` in discovery order; a record's `short_row`/`long_row` is reported when the record ends,
  with `line` = the 1-based line the record started on (counting LF, CRLF and lone CR inside quotes) and `row` = its
  index in `rows`, null for the header.

Two subtleties that are easy to get wrong and are handled explicitly: `quote_junk` depends on whether the unquoted read
after the closing quote stored anything (a lone CR dropped there leaves the field *not* junked), and the header's width
is fixed before `columns` is assigned.

## Speed strategy

- **Slice, never build.** Each field is one `text.slice(start, end)`. V8 makes these cheap sliced strings; the reference
  instead concatenates character by character, which allocates a rope per field and makes the later `JSON.stringify`
  flatten millions of cons-strings. This is the single largest win.
- **One comparison in the hot loop.** Only `,` (44), LF (10) and CR (13) can end an unquoted field, and all three are
  `<= 44`, so a single `c <= 44` test rejects every other character instead of three comparisons per character.
- **Empty-field fast path.** A field that starts on a comma is the shared `''` with no scan and no allocation.
- **No regex and no function calls on the hot path.** Rare shapes (lone CR outside quotes, doubled quotes, unterminated
  quotes, post-quote junk) go to small helpers that mirror the reference's bookkeeping exactly.
- **Fused CR/LF normalisation.** Inside a quoted field, line counting and `\r\n`/`\r` → `\n` normalisation happen in one
  pass over the slice, and only when the field actually holds a CR.
- **Streaming output.** `main.ts` serialises each answer as soon as it is computed and drops its rows, so peak live
  memory is one case's rows plus the output string, not every case's rows at once.
- V8 incremental marking is turned off in `main.ts` before `solve.js` is imported, exactly as the house driver does and
  as the rules permit. GC-flag tuning (`--max-semi-space-size` 16/32/64) was measured and did **not** help, so no extra
  flags are set.

## Correctness

| check | result |
|---|---|
| practice gate vs `kit/practice/reference/expected.json` | **6/6 cases identical**, including every error |
| differential fuzz, short adversarial strings | **20000/20000 identical** vs the reference |
| structured fuzz, generator-shaped cases (120 seeds, LF/CRLF/CR, BOM, both header flags) | **120/120 identical** |
| byte-level comparison of `answers.json` with the baseline driver's output | **identical** (sha256 `bb5b6cc5…01002ed`, 12,073,155 bytes) |
| determinism, two runs | **byte-identical** |

## Timing on the practice set

Whole-program wall time (`node main.ts`, same cases file, same machine, cold process each round), 5 rounds per side:

| | average | best |
|---|---|---|
| baseline `csv-reader 1.0.0` | **1.203 s** | 1.162 s |
| this entry | **0.639 s** | 0.619 s |

**≈1.88× faster** (an earlier 4-round run measured 1.416 s vs 0.646 s, ≈2.19×; baseline warm-up varies between runs).

Phase breakdown on one cold run — parse: 0.513 s → ~0.25 s; `JSON.stringify`: 0.381 s → 0.088 s (the sliced-string win).

## License

MIT — see `LICENSE`.
