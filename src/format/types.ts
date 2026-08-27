/**
 * src/capture/types.ts — TypeScript types for capture output
 *
 * These types describe the data produced by the capture scripts
 * (browse-and-capture.mjs, cdp-capture.ts) and consumed by the
 * spec generator and future validator.
 */

/** Metadata about a capture session. */
export interface CaptureSession {
  /** ISO 8601 timestamp when the capture started. */
  timestamp: string;

  /** Base URL of the target application. */
  targetUrl: string;

  /** Hostname filter used during capture. */
  hostFilter: string;

  /** Absolute path to the capture output directory. */
  outputDir: string;

  /** Total number of requests captured. */
  totalRequests: number;

  /** Total number of screenshots taken. */
  totalScreenshots: number;

  /** Number of unique pages visited. */
  pagesVisited: number;

  /** Number of console log entries captured. */
  consoleLogCount: number;
}

/**
 * Separator used to pack multiple values of the same response header (in
 * practice this only ever happens for Set-Cookie — see
 * CapturedTraffic.responseHeaders) into the single string this format's
 * Record<string, string> shape allows. A raw newline can't appear inside a
 * real header value, so it's a safe packing separator — see
 * src/format/headers.ts's packMultiValueHeader/unpackMultiValueHeader for
 * the pack/unpack functions themselves and the fuller rationale. Defined
 * here (the pure-type/format module both depend on) rather than in
 * headers.ts, so src/format/redact.ts — which needs it too, to redact a
 * packed multi-value Set-Cookie per-value instead of collapsing the whole
 * packed string to one placeholder — can reference it without creating an
 * import cycle with headers.ts (which already depends on redact.ts for
 * isSecretHeaderName).
 */
export const MULTI_VALUE_HEADER_SEPARATOR = '\n';

/** A paired request + response captured during browsing. */
export interface CapturedTraffic {
  /** Full request URL. */
  url: string;

  /** HTTP method. */
  method: string;

  /** POST body data, if any. */
  postData: string | null;

  /** HTTP status code. */
  status: number;

  /** Content-Type header value. */
  contentType: string;

  /**
   * Unix timestamp in milliseconds, historically the moment the response
   * completed. Kept for backward compatibility with existing captures and
   * consumers (e.g. mock-server.ts replay); prefer tsEnd for new code.
   */
  ts: number;

  /**
   * Unix timestamp in milliseconds when the request was sent. Optional
   * because older captures (pre-dating this field) won't have it.
   */
  tsStart?: number;

  /**
   * Unix timestamp in milliseconds when the response completed. Equal to
   * `ts` for entries captured after this field was introduced. Optional
   * because older captures won't have it.
   */
  tsEnd?: number;

  /** Response body as string, if captured. */
  responseBody: string | null;

  /**
   * Request headers, redacted (src/format/redact.ts) before this entry is
   * ever written to disk — credential-bearing values (Authorization,
   * Cookie, X-Api-Key, ...) become "[REDACTED]", everything else passes
   * through unchanged. Header names are lower-cased (mirrors Playwright's
   * own Request#allHeaders()). Optional because it's new in format version
   * 2 (see CURRENT_CAPTURE_FORMAT_VERSION below) — every capture written
   * before SP-lsc.8 simply lacks this field, and loaders/matching must
   * treat that the same as "no header constraints", not an error.
   */
  requestHeaders?: Record<string, string>;

  /**
   * Response headers, redacted the same way. A header that appeared
   * multiple times on the real response — in practice this only happens
   * for Set-Cookie — is packed into one string with
   * packMultiValueHeader/unpackMultiValueHeader (src/format/headers.ts);
   * unpack before treating a value as a single header line. Optional for
   * the same reason as requestHeaders.
   */
  responseHeaders?: Record<string, string>;

  /**
   * Set when this entry was synthetically produced by the seeded fault
   * injector (src/agent/fault-injector.ts) rather than observed from the
   * live target — e.g. "500", "timeout", "abort", "empty". Absent for real
   * traffic. Evidence consumers should treat entries carrying this field as
   * a manufactured resilience-test condition, not a genuine regression.
   */
  injectedFault?: string;
}

/** A browser console log entry. */
export interface CapturedConsoleEntry {
  /** Console method type: log, warn, error, info, debug, etc. */
  type: string;

  /** The logged text. */
  text: string;

  /** Unix timestamp in milliseconds. */
  ts: number;
}

/**
 * Manifest describing all files in a capture session directory.
 * Used to discover and load capture data programmatically.
 */
export interface CaptureManifest {
  /** Session metadata. */
  session: CaptureSession;

  /**
   * Whether credential redaction (src/format/redact.ts) ran on this
   * capture's request/response bodies — and header values, where headers
   * are captured at all — before anything was written to disk. `false`
   * means the capture was taken with `--no-redact` (or MOCKIFY_NO_REDACT)
   * and may contain live tokens/cookies/API keys in plain text.
   */
  redaction: boolean;

  /**
   * traffic.json entry format version — see CURRENT_CAPTURE_FORMAT_VERSION
   * below. Absent on a manifest written before this field existed; treat a
   * missing value the same as version 1 (resolveCaptureFormatVersion does
   * exactly this). Every consumer of traffic.json must keep loading older
   * versions rather than rejecting them — CapturedTraffic's new fields are
   * all optional for exactly that reason.
   */
  formatVersion?: number;

  /** Path to traffic.json relative to the capture directory. */
  trafficFile: string;

  /** Path to console.json relative to the capture directory (may not exist). */
  consoleFile?: string;

  /** Paths to screenshot PNGs relative to the capture directory. */
  screenshotFiles: string[];

  /** Path to summary.txt relative to the capture directory. */
  summaryFile?: string;

  /** Path to js-sources.json relative to the capture directory. */
  jsSourcesFile?: string;

  /**
   * Path to observations.json relative to the capture directory, if a
   * runner-recorded per-step trace (ObservationRecorder) was written for
   * this session. See src/agent/observation.ts.
   */
  observationsFile?: string;
}

/**
 * Current traffic.json entry format version, written to manifest.json's
 * `formatVersion` field by CaptureCollector.save() (src/agent/capture.ts).
 *
 *   1 (implicit — no `formatVersion` field was ever written for this
 *     version) — the original flat request/response pair shape: url,
 *     method, postData, status, contentType, ts[Start/End], responseBody.
 *   2 — adds optional requestHeaders/responseHeaders (SP-lsc.8).
 *
 * Bump this whenever CapturedTraffic's shape changes in a way a strict
 * consumer might care about, and add a line above describing what changed.
 * Every field added at version 2+ must stay optional so a loader written
 * for a later version still accepts an earlier one without special-casing —
 * see resolveCaptureFormatVersion.
 */
export const CURRENT_CAPTURE_FORMAT_VERSION = 2;

/** manifest.formatVersion, defaulting to 1 for a manifest written before
 * that field existed (or a manifest that's missing/unreadable entirely). */
export function resolveCaptureFormatVersion(
  manifest: Pick<CaptureManifest, 'formatVersion'> | null | undefined,
): number {
  return manifest?.formatVersion ?? 1;
}
