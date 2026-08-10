/**
 * src/infer/contract.ts — the implementation contract (SP-q50.1)
 *
 * This is phase 1 of the "generate a real mock implementation" epic
 * (SP-qd4): before anything can generate an implementation, mockify needs a
 * fixed, documented shape that a generated implementation must satisfy, and
 * a way to load one at runtime. Nothing in this file (or this phase)
 * generates code — src/infer/harness.ts is the measuring instrument that
 * will grade whatever a later phase produces.
 *
 * -- The contract -----------------------------------------------------------
 * An implementation is a plain ESM module (`.mjs`, no build step, loadable
 * with a bare `import()`) whose default export is an object:
 *
 *   export default {
 *     reset() {},                       // restore initial seeded state
 *     handle({ method, path, query, headers, body }) {
 *       // return { status, contentType, body } or null to decline
 *     }
 *   }
 *
 * `reset()` is called once before a full validation run (see
 * validateImplementation in harness.ts) — it must put any in-memory state
 * (a seeded store, counters, etc.) back to its initial condition, so a
 * train run and a holdout run each start from the same baseline rather than
 * leaking state between them. It may be async.
 *
 * `handle()` is called once per recorded request/response pair, in the
 * order the harness feeds them, and must not assume any particular order
 * beyond "reset() was called first". It receives:
 *   - method:  HTTP method, uppercased (e.g. "GET", "POST")
 *   - path:    the URL pathname only, no query string (e.g. "/api/items/7")
 *   - query:   parsed query-string params as a flat string map (last value
 *              wins for repeated keys)
 *   - headers: request headers as a flat string map. Captured traffic
 *              (src/format/types.ts CapturedTraffic) does not retain
 *              per-request headers today, so the harness always passes {}
 *              here — the field exists in the contract for forward
 *              compatibility and for implementations exercised outside the
 *              harness (e.g. by mock-server.ts in a later phase).
 *   - body:    the raw request body as a string (e.g. JSON text or a
 *              urlencoded form), or undefined when the recorded request had
 *              none. The implementation is responsible for parsing it.
 *
 * It must return one of:
 *   - { status, contentType, body }: a response. `body` may be a string
 *     (sent as-is) or a plain object/array (the harness treats it as
 *     already-parsed JSON for comparison, and a real server would
 *     JSON.stringify it before sending).
 *   - null: explicitly decline to answer this request. The harness grades a
 *     decline as `fail` — same as a thrown error — since it means the
 *     implementation didn't even attempt the recorded route.
 * It may be async (return a Promise of the above).
 *
 * -- Why this shape ----------------------------------------------------------
 * Plain ESM + no build step: a generated implementation must be trivially
 * loadable by both the validation harness and (eventually) mock-server.ts
 * without a compile pass — dynamic `import()` is the only mechanism used.
 * A single `handle()` entry point (rather than a router/framework) keeps the
 * contract small enough that both an LLM generating one and this harness
 * grading one can reason about it exactly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A recorded request, translated into the shape handle() receives. */
export interface HandleRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | undefined;
}

/** What handle() must return to answer a request (or null to decline). */
export interface HandleResponse {
  status: number;
  contentType: string;
  body: string | Record<string, unknown> | unknown[];
}

/** The full contract a generated (or hand-written) implementation module
 * must satisfy via its default export. */
export interface Implementation {
  reset(): void | Promise<void>;
  handle(req: HandleRequest): HandleResponse | null | Promise<HandleResponse | null>;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export type ImplementationLoadErrorCode = 'not_found' | 'import_failed' | 'invalid_shape';

/** Thrown by loadImplementation(). `code` lets callers (e.g. the CLI)
 * distinguish "nothing generated yet" (the normal state before SP-qd4's
 * later phases land) from "something exists but is broken". */
export class ImplementationLoadError extends Error {
  readonly code: ImplementationLoadErrorCode;

  constructor(message: string, code: ImplementationLoadErrorCode) {
    super(message);
    this.name = 'ImplementationLoadError';
    this.code = code;
  }
}

/** Check the shape of a dynamically-imported module's default export against
 * the contract, without executing reset()/handle(). Returns a human-readable
 * description of the first problem found, or null if it looks conformant. */
function describeShapeProblem(mod: unknown): string | null {
  const candidate = (mod as { default?: unknown } | null | undefined)?.default;
  if (candidate === undefined) {
    return 'module has no default export (expected `export default { reset, handle }`)';
  }
  if (typeof candidate !== 'object' || candidate === null) {
    return `default export is a ${typeof candidate}, expected an object with reset() and handle()`;
  }

  const obj = candidate as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof obj.reset !== 'function') missing.push('reset()');
  if (typeof obj.handle !== 'function') missing.push('handle()');
  if (missing.length > 0) {
    return `default export is missing: ${missing.join(', ')}`;
  }

  return null;
}

/** Dynamically import an implementation module and validate its shape
 * against the contract. Throws ImplementationLoadError with a clear,
 * actionable message (and a `code` a caller can branch on) rather than
 * letting an import failure or a malformed module surface as a raw
 * exception. Accepts an absolute path or one relative to process.cwd(). */
export async function loadImplementation(implPath: string): Promise<Implementation> {
  const resolved = path.isAbsolute(implPath) ? implPath : path.resolve(process.cwd(), implPath);

  if (!fs.existsSync(resolved)) {
    throw new ImplementationLoadError(`No implementation found at ${resolved}.`, 'not_found');
  }

  let mod: unknown;
  try {
    mod = await import(pathToFileURL(resolved).href);
  } catch (err) {
    throw new ImplementationLoadError(
      `Failed to load implementation at ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
      'import_failed'
    );
  }

  const problem = describeShapeProblem(mod);
  if (problem) {
    throw new ImplementationLoadError(
      `Implementation at ${resolved} does not satisfy the contract (src/infer/contract.ts): ${problem}.\n` +
        'Expected: export default { reset() {...}, handle({ method, path, query, headers, body }) {...} }',
      'invalid_shape'
    );
  }

  return (mod as { default: Implementation }).default;
}
