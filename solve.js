// solve.js — a drop-in replacement for csv-reader 1.0.0's readCsv, written from scratch for speed.
//
// run(input) returns exactly csv-reader 1.0.0's answer for {text, header}: {columns, rows, errors}.
//
// Strategy: one left-to-right pass over the text by UTF-16 index. Fields are cut with slice() (V8 makes these cheap
// sliced strings) instead of being built character by character, so the hot path allocates one string per field and
// nothing else. No regex and no function calls on the hot path; the rare paths (a lone CR outside quotes, a doubled
// quote, an unclosed quote, junk after a closing quote) fall back to small helpers that reproduce the reference's
// bookkeeping exactly.
//
// Behaviours that are easy to get wrong and are reproduced here deliberately:
//   * the `added` count of an unquoted read counts only characters kept in THAT read, so a closing quote followed by
//     stray CRs alone is not quote_junk;
//   * a record's `line` is captured when the record starts and its `row` is rows.length at that moment (null for the
//     header), so short_row/long_row report the record's own start line, not the line it ended on;
//   * width is fixed by the first accepted record even when that record is the header;
//   * a line left with no characters after stray CRs are dropped is no record, though its stray_cr errors stay;
//   * inside quotes each CRLF and each lone CR becomes one LF and counts one line.

const COMMA = 1;
const LINE_BREAK = 2;
const END = 0;

// Reads an unquoted field slowly: used only when a lone CR (or a reset after an unclosed quote) is met. Mirrors the
// reference's readUnquoted: `prefix` is the text the field already holds, and `added` counts only what this read
// keeps, never the prefix.
function slowUnquoted(text, n, p, line, prefix, errors, recordLine, recordRow) {
  const pieces = [];
  if (prefix !== '') pieces.push(prefix);
  let added = 0;
  let segStart = p;
  let ended = END;
  while (p < n) {
    const c = text.charCodeAt(p);
    if (c === 44) {
      pieces.push(text.slice(segStart, p));
      added += p - segStart;
      p += 1;
      ended = COMMA;
      break;
    }
    if (c === 10) {
      pieces.push(text.slice(segStart, p));
      added += p - segStart;
      p += 1;
      line += 1;
      ended = LINE_BREAK;
      break;
    }
    if (c === 13) {
      if (p + 1 < n && text.charCodeAt(p + 1) === 10) {
        pieces.push(text.slice(segStart, p));
        added += p - segStart;
        p += 2;
        line += 1;
        ended = LINE_BREAK;
        break;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pieces.push(text.slice(segStart, p));
      added += p - segStart;
      p += 1;
      segStart = p;
      continue;
    }
    p += 1;
  }
  if (ended === END) {
    pieces.push(text.slice(segStart, n));
    added += n - segStart;
  }
  return { value: pieces.join(''), pos: p, line, ended, added };
}

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let i = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  for (;;) {
    // A line left with no characters is no record.
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 10) {
        i += 1;
        line += 1;
      } else if (c === 13) {
        if (i + 1 < n && text.charCodeAt(i + 1) === 10) {
          i += 2;
          line += 1;
        } else {
          break;
        }
      } else {
        break;
      }
    }
    if (i >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    let ended = END;

    for (;;) {
      let value;
      let quoted = false;
      ended = END;

      if (i < n && text.charCodeAt(i) === 34) {
        // A field that opens with a quote.
        quoted = true;
        const openLine = line;
        let p = i + 1;
        let start = p;
        let pieces = null;
        let q = -1;
        for (;;) {
          q = text.indexOf('"', p);
          if (q < 0) break;
          if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
            if (pieces === null) pieces = [];
            pieces.push(text.slice(start, q + 1));
            p = q + 2;
            start = p;
            continue;
          }
          break;
        }

        if (q < 0 || !(text.charCodeAt(q) === 34)) {
          // Never closes: the quote is a literal character and the text after it is read again as unquoted.
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = slowUnquoted(text, n, i + 1, line, '"', errors, recordLine, recordRow);
          value = r.value;
          i = r.pos;
          line = r.line;
          ended = r.ended;
        } else {
          let content;
          if (pieces === null) {
            content = text.slice(start, q);
          } else {
            pieces.push(text.slice(start, q));
            content = pieces.join('');
          }
          if (content.indexOf('\r') >= 0 || content.indexOf('\n') >= 0) {
            // Every CRLF and every lone CR inside quotes is one LF, and every LF, CRLF and lone CR one line.
            const L = content.length;
            let out = '';
            let segStart = 0;
            for (let k = 0; k < L; ) {
              const cc = content.charCodeAt(k);
              if (cc === 13) {
                line += 1;
                out += content.slice(segStart, k) + '\n';
                k += k + 1 < L && content.charCodeAt(k + 1) === 10 ? 2 : 1;
                segStart = k;
              } else {
                if (cc === 10) line += 1;
                k += 1;
              }
            }
            if (out !== '') content = out + content.slice(segStart);
          }
          value = content;
          i = q + 1;

          if (i >= n) {
            ended = END;
          } else {
            const c = text.charCodeAt(i);
            if (c === 44) {
              i += 1;
              ended = COMMA;
            } else if (c === 10) {
              i += 1;
              line += 1;
              ended = LINE_BREAK;
            } else if (c === 13 && i + 1 < n && text.charCodeAt(i + 1) === 10) {
              i += 2;
              line += 1;
              ended = LINE_BREAK;
            } else {
              // What follows the closing quote, up to the next comma or line break, is appended as it stands.
              const r = slowUnquoted(text, n, i, line, value, errors, recordLine, recordRow);
              value = r.value;
              i = r.pos;
              line = r.line;
              ended = r.ended;
              if (r.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            }
          }
        }
      } else {
        // An empty field (a leading or doubled comma) needs no slice at all: hand back the shared empty string and
        // skip the scan. The generator emits these constantly, so this is a real saving, not a micro-tweak.
        if (text.charCodeAt(i) === 44) {
          fields.push('');
          lastQuoted = false;
          i += 1;
          continue;
        }
        // An unquoted field: cut at the next comma or line break, with quotes kept as literal characters.
        // Only 44 (comma), 10 (LF) and 13 (CR) end it, and all are <= 44, so one comparison rejects every other
        // character -- the single biggest win in the hot path.
        scan: {
          let p = i;
          while (p < n) {
            const c = text.charCodeAt(p);
            if (c <= 44) {
              if (c === 44) {
                value = text.slice(i, p);
                i = p + 1;
                ended = COMMA;
                break scan;
              }
              if (c === 10) {
                value = text.slice(i, p);
                i = p + 1;
                line += 1;
                ended = LINE_BREAK;
                break scan;
              }
              if (c === 13) {
                if (p + 1 < n && text.charCodeAt(p + 1) === 10) {
                  value = text.slice(i, p);
                  i = p + 2;
                  line += 1;
                  ended = LINE_BREAK;
                  break scan;
                }
                const r = slowUnquoted(text, n, i, line, '', errors, recordLine, recordRow);
                value = r.value;
                i = r.pos;
                line = r.line;
                ended = r.ended;
                break scan;
              }
            }
            p += 1;
          }
          value = text.slice(i, n);
          i = n;
          ended = END;
        }
      }

      fields.push(value);
      lastQuoted = quoted;
      if (ended !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns === null ? [] : columns) : null, rows, errors };
}
