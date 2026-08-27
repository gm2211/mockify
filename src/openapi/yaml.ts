/**
 * src/openapi/yaml.ts — minimal YAML serializer (and matching reader) for
 * JSON-compatible values.
 *
 * mockify's dependency list has no YAML library, and OpenAPI documents are
 * conventionally shipped as YAML, so this hand-rolls just enough of the
 * format rather than pulling in a general-purpose parser/dumper: block
 * style only (no flow `{}`/`[]` collections beyond the empty case, no
 * anchors/aliases, no multiline block scalars, no comments) — everything
 * toYaml() ever emits is 2-space-indented block mappings/sequences with
 * scalars that are either left bare or JSON-quoted. fromYaml() is the exact
 * inverse of that specific subset (used to round-trip test toYaml(), and
 * available to any other reader of a document this module wrote) — it is
 * NOT a general YAML parser and will misparse hand-written YAML that uses
 * flow style, block scalars, or comments.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };

const INDENT = '  ';

function isScalar(value: JsonValue): value is null | boolean | number | string {
  return value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
}

/** True when `s` can appear unquoted as a YAML plain scalar without being
 * misread as something else (a mapping key/value separator, a reserved
 * word, a number, a sequence/document indicator, ...). Conservative by
 * design — anything not obviously safe gets JSON-quoted instead. */
function isPlainScalarSafe(s: string): boolean {
  if (s.length === 0) return false;
  if (/^\s|\s$/.test(s)) return false; // leading/trailing whitespace
  if (/[\x00-\x1f]/.test(s)) return false; // control chars, including newlines
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return false; // leading YAML indicator char
  if (s.includes(': ') || s.endsWith(':') || s.includes(' #')) return false; // would read as a mapping key or a comment
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return false; // reserved scalars
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return false; // would read as a number
  return true;
}

function dumpScalar(value: null | boolean | number | string): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  return isPlainScalarSafe(value) ? value : JSON.stringify(value);
}

/** Render `value` (object/array) as a block, one fully-indented line per
 * array entry. Scalars at the top level of a sequence item are inlined
 * after "- "; nested containers have their first line's own indent
 * collapsed into the "- " prefix (the standard trick: "- " and one indent
 * level are both 2 columns wide, so continuation lines line up). */
function dumpNode(value: JsonValue, indent: number): string[] {
  if (isScalar(value)) return [INDENT.repeat(indent) + dumpScalar(value)];

  if (Array.isArray(value)) {
    if (value.length === 0) return [INDENT.repeat(indent) + '[]'];
    const lines: string[] = [];
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(INDENT.repeat(indent) + '- ' + dumpScalar(item));
        continue;
      }
      const childLines = dumpNode(item, indent + 1);
      const childIndent = INDENT.repeat(indent + 1);
      const first = childLines[0].startsWith(childIndent) ? childLines[0].slice(childIndent.length) : childLines[0];
      lines.push(INDENT.repeat(indent) + '- ' + first);
      lines.push(...childLines.slice(1));
    }
    return lines;
  }

  // object
  const entries = Object.entries(value).filter(([, v]) => v !== undefined) as Array<[string, JsonValue]>;
  if (entries.length === 0) return [INDENT.repeat(indent) + '{}'];
  const lines: string[] = [];
  for (const [key, v] of entries) {
    const keyStr = dumpScalar(key);
    if (isScalar(v) || (Array.isArray(v) && v.length === 0) || (!Array.isArray(v) && Object.keys(v).length === 0)) {
      lines.push(`${INDENT.repeat(indent)}${keyStr}: ${dumpNode(v, indent).map((l) => l.trimStart()).join('')}`);
    } else {
      lines.push(`${INDENT.repeat(indent)}${keyStr}:`);
      lines.push(...dumpNode(v, indent + 1));
    }
  }
  return lines;
}

/** Serialize a JSON-compatible value as YAML (block style, 2-space indent).
 * `undefined` object values are dropped, mirroring JSON.stringify. Always
 * ends with a trailing newline. */
export function toYaml(value: JsonValue): string {
  if (isScalar(value)) return dumpScalar(value) + '\n';
  return dumpNode(value, 0).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// fromYaml — inverse of toYaml, for the subset described above.
// ---------------------------------------------------------------------------

interface Line {
  indent: number;
  /** '-' marks "a sequence item starts here, its content is the next line
   * (at indent+2)"; anything else is a mapping-key line or a bare scalar. */
  text: string;
}

function preprocess(raw: string): Line[] {
  const out: Line[] = [];
  for (const rawLine of raw.split('\n')) {
    if (rawLine.trim().length === 0) continue;
    let indent = 0;
    while (rawLine[indent] === ' ') indent++;
    let rest = rawLine.slice(indent);
    while (rest.startsWith('- ') || rest === '-') {
      out.push({ indent, text: '-' });
      indent += 2;
      rest = rest === '-' ? '' : rest.slice(2);
    }
    out.push({ indent, text: rest });
  }
  return out;
}

/** Find the index of the colon that separates a mapping key from its value
 * on `text` — the first ':' outside of a double-quoted span, followed by a
 * space or end-of-string (matching what toYaml ever emits: a plain or
 * JSON-quoted key, then ": " or a bare trailing ":"). Returns -1 if `text`
 * isn't a mapping-key line at all (e.g. a bare scalar). */
function findKeyColon(text: string): number {
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && text[i - 1] !== '\\') inQuotes = !inQuotes;
    if (!inQuotes && c === ':' && (i === text.length - 1 || text[i + 1] === ' ')) return i;
  }
  return -1;
}

function parseScalarText(raw: string): JsonValue {
  const s = raw.trim();
  if (s === '{}') return {};
  if (s === '[]') return [];
  if (s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^[-+]?\d+$/.test(s)) return parseInt(s, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return parseFloat(s);
  if (s.startsWith('"')) return JSON.parse(s) as string;
  return s;
}

/** Parse the block starting at `lines[state.idx]`, which must have exactly
 * `indent`. Consumes every line belonging to that block (advancing
 * state.idx) and returns its value. */
function parseBlock(lines: Line[], state: { idx: number }, indent: number): JsonValue {
  const first = lines[state.idx];
  if (first.text === '-') {
    const arr: JsonValue[] = [];
    while (state.idx < lines.length && lines[state.idx].indent === indent && lines[state.idx].text === '-') {
      state.idx++; // consume marker
      const contentIndent = lines[state.idx].indent;
      arr.push(parseBlock(lines, state, contentIndent));
    }
    return arr;
  }

  const colonIdx = findKeyColon(first.text);
  if (colonIdx === -1) {
    // Bare scalar occupying this whole block (only reachable for a
    // top-level document that's just a scalar, or a sequence item that was
    // a scalar — the latter is handled inline by the array branch's caller
    // via parseBlock recursion too, which is fine since it's a one-line
    // block).
    state.idx++;
    return parseScalarText(first.text);
  }

  const obj: Record<string, JsonValue> = {};
  while (state.idx < lines.length && lines[state.idx].indent === indent && lines[state.idx].text !== '-') {
    const line = lines[state.idx];
    const ci = findKeyColon(line.text);
    const keyRaw = line.text.slice(0, ci).trim();
    const key = keyRaw.startsWith('"') ? (JSON.parse(keyRaw) as string) : keyRaw;
    const valuePart = line.text.slice(ci + 1).trim();
    state.idx++;
    if (valuePart === '') {
      if (state.idx < lines.length && lines[state.idx].indent > indent) {
        obj[key] = parseBlock(lines, state, lines[state.idx].indent);
      } else {
        obj[key] = null;
      }
    } else {
      obj[key] = parseScalarText(valuePart);
    }
  }
  return obj;
}

/** Parse YAML text produced by toYaml() back into the JSON-compatible value
 * it was built from. See the module doc: this only understands toYaml's own
 * output subset, not arbitrary YAML. */
export function fromYaml(text: string): JsonValue {
  const lines = preprocess(text);
  if (lines.length === 0) return null;
  const state = { idx: 0 };
  return parseBlock(lines, state, lines[0].indent);
}
