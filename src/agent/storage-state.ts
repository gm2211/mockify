/**
 * src/agent/storage-state.ts — Shared resolution for --storage-state / --save-storage-state
 *
 * Storage-state files hold live session cookies/localStorage — a credential
 * at rest. This module supports two forms for both flags:
 *
 *   - a filesystem path (unchanged behavior: validated, written 0600)
 *   - `keychain:<name>` (macOS only): stored/read via the macOS Keychain
 *     through `security`, never touching disk.
 *
 * Nothing in this module ever logs file contents or cookie values — only
 * paths and keychain names.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

const KEYCHAIN_PREFIX = 'keychain:';
/**
 * Fixed account name under which all mockify keychain items are stored; the
 * service name (after `keychain:`) is the operator-chosen identifier. Kept
 * distinct from specify's 'specify' account — this project's recorders are
 * a copy-first port, and specify-saved keychain items are intentionally not
 * shared with (or readable by) mockify.
 */
const KEYCHAIN_ACCOUNT = 'mockify';

// Pin every keychain operation to the user's login keychain. Without an
// explicit keychain, `security` walks the default search list — which includes
// /Library/Keychains/System.keychain — and merely reaching that one makes
// macOS raise a modal "security wants to make changes / enter an
// administrator's name and password" prompt. Mockify never needs the System
// keychain, so naming the login keychain keeps the flow prompt-free.
const LOGIN_KEYCHAIN = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
/** Keychain item/service names go straight into a `security -i` command line (not argv), so restrict them to a safe token charset. */
const SAFE_KEYCHAIN_NAME = /^[A-Za-z0-9._-]+$/;

export interface StorageStateError {
  error: 'invalid_storage_state' | 'keychain_unsupported' | 'keychain_error';
  target: string;
  hint: string;
}

export function isKeychainRef(value: string): boolean {
  return value.startsWith(KEYCHAIN_PREFIX);
}

export function keychainName(value: string): string {
  return value.slice(KEYCHAIN_PREFIX.length);
}

/**
 * Validate that `storageStatePath` exists and contains parseable JSON.
 * Returns null when valid, or a structured error object (safe to write to
 * stdout as-is) otherwise. Never reads the file's contents into the error.
 */
export function validateStorageStatePath(storageStatePath: string): StorageStateError | null {
  const resolved = path.resolve(storageStatePath);

  if (!fs.existsSync(resolved)) {
    return { error: 'invalid_storage_state', target: storageStatePath, hint: 'Storage-state file not found' };
  }

  try {
    JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  } catch {
    return { error: 'invalid_storage_state', target: storageStatePath, hint: 'Storage-state file is not valid JSON' };
  }

  return null;
}

/** Warn (never block) when a storage-state file is readable by group/other. */
function warnIfInsecurePermissions(resolvedPath: string, log: (msg: string) => void): void {
  try {
    const mode = fs.statSync(resolvedPath).mode & 0o777;
    if (mode & 0o077) {
      log(`Warning: ${resolvedPath} is group- or world-readable; run "chmod 600 ${resolvedPath}" to protect the session cookies it contains`);
    }
  } catch {
    // Best-effort; never block the run over a permission-check failure.
  }
}

// ---------------------------------------------------------------------------
// macOS Keychain backend
//
// Reads use `security find-generic-password ... -w`, invoked with an argv
// array (no shell) — safe, since only the (non-secret) item name is an
// argument; the secret only ever appears on stdout.
//
// Writes use `security -i` (batch/interactive mode): commands are fed on
// stdin, never as argv, so the secret never appears in this process's (or
// `security`'s) argument list — invisible to `ps`. The secret is additionally
// base64-encoded before being embedded in the command line: `security -i`'s
// line tokenizer does not reliably round-trip raw JSON (embedded newlines,
// in particular, are mishandled even when hex/quoted), while the base64
// alphabet ([A-Za-z0-9+/=]) is always a single safe token.
// ---------------------------------------------------------------------------

function runSecurityInteractive(commandLine: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.write(commandLine + '\n');
    child.stdin.end();
  });
}

function runSecurityFind(name: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('security', [
      'find-generic-password',
      '-s', name,
      '-a', KEYCHAIN_ACCOUNT,
      '-w',
      LOGIN_KEYCHAIN,
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function keychainUnsupportedError(name: string): StorageStateError {
  return {
    error: 'keychain_unsupported',
    target: `keychain:${name}`,
    hint: 'keychain: storage state is only supported on macOS; use a filesystem path instead',
  };
}

async function readKeychain(name: string): Promise<{ ok: true; json: string } | { ok: false; error: StorageStateError }> {
  if (process.platform !== 'darwin') {
    return { ok: false, error: keychainUnsupportedError(name) };
  }
  if (!SAFE_KEYCHAIN_NAME.test(name)) {
    return { ok: false, error: { error: 'keychain_error', target: `keychain:${name}`, hint: 'Keychain name must match [A-Za-z0-9._-]+' } };
  }
  try {
    const { code, stdout } = await runSecurityFind(name);
    if (code !== 0) {
      return { ok: false, error: { error: 'keychain_error', target: `keychain:${name}`, hint: `No keychain item named "${name}" found for account "${KEYCHAIN_ACCOUNT}"` } };
    }
    const b64 = stdout.replace(/\n$/, '');
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    return { ok: true, json };
  } catch (err) {
    return { ok: false, error: { error: 'keychain_error', target: `keychain:${name}`, hint: err instanceof Error ? err.message : String(err) } };
  }
}

async function writeKeychain(name: string, json: string): Promise<{ ok: true } | { ok: false; error: StorageStateError } > {
  if (process.platform !== 'darwin') {
    return { ok: false, error: keychainUnsupportedError(name) };
  }
  if (!SAFE_KEYCHAIN_NAME.test(name)) {
    return { ok: false, error: { error: 'keychain_error', target: `keychain:${name}`, hint: 'Keychain name must match [A-Za-z0-9._-]+' } };
  }
  try {
    const b64 = Buffer.from(json, 'utf-8').toString('base64');
    const commandLine = `add-generic-password -U -a ${KEYCHAIN_ACCOUNT} -s ${name} -w '${b64}' '${LOGIN_KEYCHAIN}'`;
    const { code, stderr } = await runSecurityInteractive(commandLine);
    if (code !== 0) {
      return { ok: false, error: { error: 'keychain_error', target: `keychain:${name}`, hint: stderr.trim().split('\n').pop() || 'security -i failed' } };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: { error: 'keychain_error', target: `keychain:${name}`, hint: err instanceof Error ? err.message : String(err) } };
  }
}

// ---------------------------------------------------------------------------
// Public resolution API
// ---------------------------------------------------------------------------

/**
 * Resolve a `--storage-state` value (path or `keychain:<name>`) into
 * something Playwright's `storageState` context option accepts directly:
 * a file path (unchanged) or the parsed storage-state object (keychain).
 */
export async function resolveStorageStateInput(
  value: string,
  log: (msg: string) => void,
): Promise<{ ok: true; contextValue: string | Record<string, unknown> } | { ok: false; error: StorageStateError }> {
  if (isKeychainRef(value)) {
    const name = keychainName(value);
    const result = await readKeychain(name);
    if (!result.ok) return { ok: false, error: result.error };
    try {
      const parsed = JSON.parse(result.json) as Record<string, unknown>;
      return { ok: true, contextValue: parsed };
    } catch {
      return { ok: false, error: { error: 'keychain_error', target: value, hint: 'Keychain item did not contain valid JSON' } };
    }
  }

  const err = validateStorageStatePath(value);
  if (err) return { ok: false, error: err };
  const resolved = path.resolve(value);
  warnIfInsecurePermissions(resolved, log);
  return { ok: true, contextValue: resolved };
}

/**
 * Persist a `--save-storage-state` destination (path or `keychain:<name>`)
 * from a live Playwright browser context. Always fetches the state as an
 * in-memory object (`context.storageState()` with no `path`) and writes it
 * ourselves — for the path form so the file can be created with mode 0600
 * from the start (never briefly world-readable), and for the keychain form
 * so the secret never touches disk at all.
 */
export async function saveStorageStateOutput(
  destination: string,
  context: { storageState: () => Promise<unknown> },
  log: (msg: string) => void,
): Promise<void> {
  const state = await context.storageState();
  const json = JSON.stringify(state, null, 2);

  if (isKeychainRef(destination)) {
    const name = keychainName(destination);
    const result = await writeKeychain(name, json);
    if (result.ok) {
      log(`Storage state saved: keychain:${name}`);
    } else {
      log(`Warning: failed to save storage state to keychain:${name}: ${result.error.hint}`);
    }
    return;
  }

  const resolved = path.resolve(destination);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolved, json, { mode: 0o600 });
  // writeFileSync only applies `mode` when it creates the file, so overwriting
  // a pre-existing state file would silently keep permissions we just widened
  // away from. Re-assert them.
  fs.chmodSync(resolved, 0o600);
  log(`Storage state saved: ${resolved}`);
}
