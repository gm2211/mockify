/**
 * src/test-helpers/spawn-mock-server.ts — shared child-process spawn + ready
 * wait for tests that exercise `mockify serve` as a real subprocess
 * (mock-server.test.ts, mock-server-synthetic.test.ts).
 *
 * SP-ish root cause: the previous per-file `waitForOutput()` helpers waited
 * for `/Loaded \d+ traffic entries|Synthetic replay disabled/` on stderr.
 * That line is written by loadTraffic() synchronously at the very start of
 * startMockServer() (src/mock-server.ts) — well before server.listen()'s
 * callback fires. In between sits `await loadImplementationForServer(...)`
 * (fs.existsSync + a dynamic import of the capture dir's impl/handlers.mjs
 * when one exists), plus whatever the event loop does before the listen
 * callback runs. Locally that gap is usually sub-millisecond, so the race
 * was invisible most runs; on a colder CI runner (slower tsx/module
 * resolution) the gap widened enough to fail deterministically — matching
 * the "ECONNREFUSED on both attempts" report, not just an occasional flake.
 * `waitForListening` below waits for the server's own "listening on
 * http://localhost:PORT" line instead — the only line that is actually
 * true only once the port is bound — with a generous default timeout for
 * CI cold starts, and it surfaces captured stdout/stderr (plus exit
 * code/signal if the child died) on failure so a real startup crash shows
 * up directly instead of manifesting as a bare ECONNREFUSED downstream.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root — this file lives at src/test-helpers/, so it's two levels up. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.ts');

/** mock-server.ts's startMockServer() prints this from inside
 * server.listen()'s callback — the one line that is only ever true once the
 * port is actually bound. */
const LISTENING_PATTERN = /Specify Mock Server listening on http:\/\/localhost:(\d+)/;

export interface SpawnedMockServer {
  child: ChildProcess;
  /** The port the server confirmed it's listening on (parsed back out of
   * the startup banner, so it's always the real bound port even if a test
   * requested port 0 or a busy port forced a fallback in the future). */
  port: number;
  /** Everything captured on stderr up to and including the listening line. */
  stderr: string;
  /** Everything captured on stdout up to that point (this codebase logs
   * startup/config to stderr, so normally empty — captured anyway so a
   * stray console.log during startup is still visible on failure). */
  stdout: string;
}

interface CapturedOutput {
  stdout: string;
  stderr: string;
}

function describe({ stdout, stderr }: CapturedOutput): string {
  return `stdout:\n${stdout || '(empty)'}\nstderr:\n${stderr || '(empty)'}`;
}

/** Wait for the server's own listening line on stderr. Rejects — with
 * captured stdout/stderr attached to the error message — if the timeout
 * elapses first or if the process exits before ever printing it (a startup
 * crash), so either failure mode is diagnosable from the test output alone. */
function waitForListening(
  child: ChildProcess,
  timeoutMs: number
): Promise<CapturedOutput & { port: number }> {
  return new Promise((resolve, reject) => {
    const captured: CapturedOutput = { stdout: '', stderr: '' };
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for the mock server to start listening.\n${describe(captured)}`
          )
        )
      );
    }, timeoutMs);

    const onStdout = (data: Buffer): void => {
      captured.stdout += data.toString();
    };
    const onStderr = (data: Buffer): void => {
      captured.stderr += data.toString();
      const match = LISTENING_PATTERN.exec(captured.stderr);
      if (match) {
        finish(() => resolve({ ...captured, port: Number(match[1]) }));
      }
    };
    const onExit = (code: number | null, signal: string | null): void => {
      finish(() =>
        reject(
          new Error(
            `mock server process exited before it started listening (code=${code}, signal=${signal}).\n${describe(captured)}`
          )
        )
      );
    };
    const onError = (err: Error): void => {
      finish(() => reject(err));
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

/**
 * Spawn `mockify serve` as a real child process — the same CLI path (run
 * through tsx) a real `mockify serve` invocation takes — and resolve only
 * once it has confirmed the port is actually bound. `timeoutMs` defaults to
 * 30s to give a cold CI runner real headroom; locally this resolves in well
 * under a second.
 *
 * `env` is merged over `process.env` (e.g. `MOCK_DATA_PATH`, `MOCK_SYNTHETIC`).
 * A random port in the 34567-35566 range is picked and passed as `PORT`
 * unless the caller already set one. `opts.args` appends extra CLI flags
 * after `serve` (e.g. `['--speed', '2']`, `['--no-latency']`) for tests that
 * need to exercise flag parsing rather than env-var-driven config.
 */
export async function spawnMockServer(
  env: Record<string, string> = {},
  opts: { timeoutMs?: number; args?: string[] } = {}
): Promise<SpawnedMockServer> {
  const requestedPort = env.PORT ?? String(34567 + Math.floor(Math.random() * 1000));
  const child = spawn(process.execPath, ['--import', 'tsx', CLI_PATH, 'serve', ...(opts.args ?? [])], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...env,
      PORT: requestedPort,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const { stdout, stderr, port } = await waitForListening(child, opts.timeoutMs ?? 30_000);
  return { child, port, stdout, stderr };
}
