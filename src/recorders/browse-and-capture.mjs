#!/usr/bin/env node

/**
 * scripts/browse-and-capture.mjs — Interactive browser capture tool
 *
 * What it does:
 *   1. Launches a visible Chrome browser (Playwright Chromium)
 *   2. Opens the target URL — you log in and browse around
 *   3. Captures ALL network traffic (requests + JSON response bodies)
 *   4. Takes a screenshot every time you navigate to a new page
 *   5. Takes debounced screenshots after significant API responses
 *   6. Captures all console logs from the browser
 *   7. On Ctrl+C: saves everything to a timestamped folder
 *
 * Usage:
 *   npm run browse
 *   node scripts/browse-and-capture.mjs
 *   node scripts/browse-and-capture.mjs --output ./my-captures
 *   TARGET_BASE_URL=https://app.example.com node scripts/browse-and-capture.mjs
 *
 * Configuration (via .env or environment variables):
 *   TARGET_BASE_URL        — URL to open on launch (required)
 *   CAPTURE_HOST_FILTER    — target hostname for traffic filtering; matched by
 *                            registrable domain, so api.example.com is captured
 *                            when the filter is www.example.com
 *                            (default: derived from TARGET_BASE_URL)
 *   SPECIFY_CAPTURE_HOST_FILTER — comma-separated extra registrable domains or
 *                            exact hostnames to also capture (for targets that
 *                            call genuinely cross-origin APIs), or "*" to
 *                            disable host filtering entirely
 *   CAPTURE_OUTPUT_DIR     — base directory for captures (default: captures)
 *   CAPTURE_SCREENSHOT_DELAY_MS — debounce ms for API screenshots (default: 800)
 *
 * Output (in <CAPTURE_OUTPUT_DIR>/<timestamp>/):
 *   traffic.json        — all captured API requests with response bodies
 *   console.json        — browser console log entries
 *   screenshots/        — auto-captured PNGs on each page navigation
 *   summary.txt         — endpoint summary table
 *   js-sources.json     — script URLs found on pages visited
 *
 * Give the output folder to an LLM for analysis.
 */

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TARGET_URL = process.env.TARGET_BASE_URL ?? "";
if (!TARGET_URL) {
  console.error("ERROR: TARGET_BASE_URL must be set.");
  console.error("  Example: TARGET_BASE_URL=https://app.example.com npm run browse");
  process.exit(1);
}

let hostFilter = process.env.CAPTURE_HOST_FILTER ?? "";
if (!hostFilter) {
  try {
    hostFilter = new URL(TARGET_URL).hostname;
  } catch {
    hostFilter = "";
  }
}

const SCREENSHOT_DELAY_MS = parseInt(process.env.CAPTURE_SCREENSHOT_DELAY_MS ?? "800", 10);

const STATIC_EXT = new Set([
  ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg",
  ".woff", ".woff2", ".ttf", ".ico", ".map", ".less",
]);

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const baseOutputDir = process.env.CAPTURE_OUTPUT_DIR ?? join(PROJECT_ROOT, "captures");
const outputIdx = args.indexOf("--output");
const outputBase = outputIdx !== -1 && args[outputIdx + 1]
  ? args[outputIdx + 1]
  : baseOutputDir;

const timestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .replace("T", "_")
  .slice(0, 19);

const outputDir = join(outputBase, timestamp);
const screenshotDir = join(outputDir, "screenshots");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const traffic = [];
const consoleLogs = [];
let screenshotCount = 0;
let lastUrl = "";
const pageUrls = new Set();
const scriptSources = new Set();
let pendingScreenshot = null; // debounce timer for API-triggered screenshots

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Host matching is by registrable domain ("eTLD+1"), not substring — a naive
// hostname.includes(hostFilter) silently drops same-site, different-subdomain
// traffic (www.example.com page calling api.example.com), which makes any
// "no request occurred" reasoning over the capture unsound. Mirrors
// registrableDomain() in src/agent/capture.ts; this script is plain JS and
// must run without a build, so the helper is ported rather than imported.

// Common two-level public suffixes where the registrable domain needs three
// labels instead of two (e.g. "example.co.uk", not "co.uk"). Pragmatic
// heuristic, not a full Public Suffix List. Widen this list (or use
// SPECIFY_CAPTURE_HOST_FILTER) if a target domain isn't matched correctly.
const TWO_LEVEL_PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "net.uk",
  "com.au", "net.au", "org.au", "gov.au",
  "co.nz", "co.jp", "co.in", "co.za", "co.kr",
  "com.br", "com.mx", "com.cn", "com.sg", "com.hk",
]);

function registrableDomain(hostname) {
  const host = hostname.toLowerCase();
  // Leave IPv4/IPv6-ish and single-label hosts (e.g. "localhost") untouched.
  if (/^[\d.]+$/.test(host) || !host.includes(".")) return host;

  const labels = host.split(".");
  if (labels.length < 2) return host;

  const lastTwo = labels.slice(-2).join(".");
  if (TWO_LEVEL_PUBLIC_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

const extraHostFilters = (process.env.SPECIFY_CAPTURE_HOST_FILTER ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const captureAllHosts = extraHostFilters.includes("*");

function hostMatchesFilter(hostname) {
  if (!hostFilter || captureAllHosts) return true;
  const host = hostname.toLowerCase();
  const requestDomain = registrableDomain(host);
  if (requestDomain === registrableDomain(hostFilter)) return true;
  return extraHostFilters.some(
    (h) => requestDomain === registrableDomain(h) || host === h
  );
}

function urlMatchesFilter(url) {
  try {
    return hostMatchesFilter(new URL(url).hostname);
  } catch {
    return false;
  }
}

function shouldCapture(url) {
  try {
    const u = new URL(url);
    if (!hostMatchesFilter(u.hostname)) return false;
    const ext = extname(u.pathname).toLowerCase();
    if (STATIC_EXT.has(ext)) return false;
    return true;
  } catch {
    return false;
  }
}

function slugify(url) {
  try {
    const u = new URL(url);
    return u.pathname
      .replace(/^\//, "")
      .replace(/[/?&#=.]/g, "_")
      .replace(/_+/g, "_")
      .replace(/_$/, "")
      .substring(0, 80);
  } catch {
    return "page";
  }
}

function save() {
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(screenshotDir, { recursive: true });

  // Save traffic
  writeFileSync(join(outputDir, "traffic.json"), JSON.stringify(traffic, null, 2));

  // Save console logs
  writeFileSync(join(outputDir, "console.json"), JSON.stringify(consoleLogs, null, 2));

  // Save script sources
  writeFileSync(
    join(outputDir, "js-sources.json"),
    JSON.stringify([...scriptSources].sort(), null, 2)
  );

  // Build summary
  const endpointMap = new Map();
  for (const req of traffic) {
    let pattern;
    try {
      const u = new URL(req.url);
      pattern = `${u.origin}${u.pathname}`;
    } catch {
      pattern = req.url;
    }
    const key = `${req.method}::${pattern}::${req.status || "?"}`;
    const existing = endpointMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      endpointMap.set(key, {
        method: req.method,
        url: pattern,
        status: req.status || "?",
        contentType: (req.contentType || "").split(";")[0].trim(),
        hasBody: !!req.responseBody,
        count: 1,
      });
    }
  }

  const sorted = [...endpointMap.values()].sort((a, b) => b.count - a.count);
  const lines = [
    `Capture: ${timestamp}`,
    `Target: ${TARGET_URL}`,
    `Host filter: ${hostFilter}`,
    `Total requests: ${traffic.length}`,
    `Unique endpoints: ${sorted.length}`,
    `Screenshots: ${screenshotCount}`,
    `Pages visited: ${pageUrls.size}`,
    `Console logs: ${consoleLogs.length}`,
    "",
    `${"#".padEnd(5)} ${"METHOD".padEnd(7)} ${"STATUS".padEnd(7)} ${"BODY?".padEnd(6)} ${"TYPE".padEnd(25)} URL`,
    "-".repeat(120),
  ];
  for (const s of sorted) {
    lines.push(
      `${String(s.count).padEnd(5)} ${s.method.padEnd(7)} ${String(s.status).padEnd(7)} ${(s.hasBody ? "YES" : "no").padEnd(6)} ${s.contentType.padEnd(25)} ${s.url}`
    );
  }

  writeFileSync(join(outputDir, "summary.txt"), lines.join("\n") + "\n");
  return sorted.length;
}

// ---------------------------------------------------------------------------
// Debounced screenshot after API activity
// ---------------------------------------------------------------------------
function scheduleApiScreenshot(page, reason) {
  if (pendingScreenshot) clearTimeout(pendingScreenshot);
  pendingScreenshot = setTimeout(async () => {
    pendingScreenshot = null;
    try {
      const currentUrl = page.url();
      const slug = slugify(currentUrl);
      const name = `${String(screenshotCount + 1).padStart(3, "0")}-${slug}.png`;
      await page.screenshot({ path: join(screenshotDir, name), fullPage: true });
      screenshotCount++;
      console.log(`  [screenshot] (${reason}): ${name}`);
    } catch {}
  }, SCREENSHOT_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("┌──────────────────────────────────────────────────────────────┐");
  console.log("│  Specify — Browse & Capture                                  │");
  console.log("├──────────────────────────────────────────────────────────────┤");
  console.log("│  1. A browser window will open                               │");
  console.log("│  2. Log in and browse around the app                         │");
  console.log("│  3. Visit every section you want captured                    │");
  console.log("│  4. Press Ctrl+C when done                                   │");
  console.log("│                                                               │");
  console.log(`│  Target: ${TARGET_URL.substring(0, 52).padEnd(52)} │`);
  console.log(`│  Filter: ${hostFilter.substring(0, 52).padEnd(52)} │`);
  console.log(`│  Output: ${outputDir.substring(0, 52).padEnd(52)} │`);
  console.log("└──────────────────────────────────────────────────────────────┘");
  console.log();

  // Use a persistent profile so cookies/cache survive across runs if desired
  const profileDir = join(
    process.env.TMPDIR ?? "/tmp",
    `specify-capture-profile-${Buffer.from(hostFilter).toString("hex").slice(0, 16)}`
  );

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = context.pages()[0] || (await context.newPage());

  // Ensure output dirs exist
  mkdirSync(screenshotDir, { recursive: true });

  // -----------------------------------------------------------------------
  // Console log capture
  // -----------------------------------------------------------------------
  page.on("console", (msg) => {
    consoleLogs.push({
      type: msg.type(),
      text: msg.text(),
      ts: Date.now(),
    });
  });

  // -----------------------------------------------------------------------
  // Network capture via route interception
  // -----------------------------------------------------------------------
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();

    // Always continue the request
    const response = await route.fetch().catch(() => null);
    if (!response) {
      await route.continue().catch(() => {});
      return;
    }

    await route.fulfill({ response }).catch(() => {});

    // Capture if it matches our host filter
    if (shouldCapture(url)) {
      const entry = {
        url,
        method,
        postData: request.postData() || null,
        status: response.status(),
        contentType: response.headers()["content-type"] || "",
        ts: Date.now(),
        responseBody: null,
      };

      // Try to capture JSON and text response bodies
      const ct = (entry.contentType || "").toLowerCase();
      if (ct.includes("json") || ct.includes("text")) {
        try {
          const body = await response.text();
          if (body.length < 2 * 1024 * 1024) {
            entry.responseBody = body;
          }
        } catch {}
      }

      traffic.push(entry);
      const shortUrl = url.length > 100 ? url.substring(0, 100) + "..." : url;
      console.log(`  [${method}] ${entry.status} ${shortUrl}`);

      // Screenshot after significant API responses
      if (entry.responseBody && entry.status === 200) {
        const isJsonData = ct.includes("json") && entry.responseBody.length > 50;
        if (isJsonData) {
          scheduleApiScreenshot(page, "data-load");
        }
      }
    }

    // Track script sources matching the host filter
    if (hostFilter && urlMatchesFilter(url) && (url.endsWith(".js") || url.includes("bundle"))) {
      scriptSources.add(url);
    }
  });

  // -----------------------------------------------------------------------
  // Auto-screenshot on full page navigation
  // -----------------------------------------------------------------------
  page.on("load", async () => {
    const currentUrl = page.url();
    if (currentUrl === lastUrl) return;
    if (hostFilter && !urlMatchesFilter(currentUrl)) return;

    lastUrl = currentUrl;
    pageUrls.add(currentUrl);

    // Wait for dynamic content to settle
    await new Promise((r) => setTimeout(r, 1500));

    const name = `${String(screenshotCount + 1).padStart(3, "0")}-${slugify(currentUrl)}.png`;
    try {
      await page.screenshot({ path: join(screenshotDir, name), fullPage: true });
      screenshotCount++;
      console.log(`  [screenshot] nav: ${name}`);
    } catch (e) {
      console.log(`  [screenshot-failed] ${e.message}`);
    }
  });

  // SPA-style navigation polling (URL changes without full page load)
  const urlCheckInterval = setInterval(async () => {
    try {
      const currentUrl = page.url();
      if (currentUrl !== lastUrl && (!hostFilter || urlMatchesFilter(currentUrl))) {
        lastUrl = currentUrl;
        pageUrls.add(currentUrl);
        await new Promise((r) => setTimeout(r, 1000));
        const name = `${String(screenshotCount + 1).padStart(3, "0")}-${slugify(currentUrl)}.png`;
        await page.screenshot({ path: join(screenshotDir, name), fullPage: true });
        screenshotCount++;
        console.log(`  [screenshot] spa-nav: ${name}`);
      }
    } catch {}
  }, 1500);

  // -----------------------------------------------------------------------
  // Navigate to target
  // -----------------------------------------------------------------------
  console.log(`\nOpening ${TARGET_URL}...\n`);
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });

  // -----------------------------------------------------------------------
  // Periodic auto-save (every 30s)
  // -----------------------------------------------------------------------
  const saveInterval = setInterval(() => {
    if (traffic.length > 0) {
      save();
      console.log(`  [autosave] ${traffic.length} requests, ${screenshotCount} screenshots`);
    }
  }, 30000);

  // -----------------------------------------------------------------------
  // Ctrl+C handler
  // -----------------------------------------------------------------------
  const cleanup = async () => {
    clearInterval(saveInterval);
    clearInterval(urlCheckInterval);

    // Take one final screenshot
    try {
      const name = `${String(screenshotCount + 1).padStart(3, "0")}-final-state.png`;
      await page.screenshot({ path: join(screenshotDir, name), fullPage: true });
      screenshotCount++;
    } catch {}

    // Grab all script tags from the current page
    try {
      const scripts = await page.evaluate(() =>
        [...document.querySelectorAll("script[src]")].map((s) => s.src)
      );
      scripts.forEach((s) => scriptSources.add(s));
    } catch {}

    const endpointCount = save();

    console.log("\n");
    console.log("┌──────────────────────────────────────────────────────────────┐");
    console.log("│  Capture Complete                                             │");
    console.log("├──────────────────────────────────────────────────────────────┤");
    console.log(`│  Requests captured: ${String(traffic.length).padEnd(41)} │`);
    console.log(`│  Unique endpoints:  ${String(endpointCount).padEnd(41)} │`);
    console.log(`│  Screenshots:       ${String(screenshotCount).padEnd(41)} │`);
    console.log(`│  Pages visited:     ${String(pageUrls.size).padEnd(41)} │`);
    console.log(`│  Console logs:      ${String(consoleLogs.length).padEnd(41)} │`);
    console.log("├──────────────────────────────────────────────────────────────┤");
    console.log(`│  Output: ${outputDir.substring(0, 52).padEnd(52)} │`);
    console.log("│                                                               │");
    console.log("│  Files:                                                       │");
    console.log("│    traffic.json     — API requests + response bodies          │");
    console.log("│    console.json     — browser console logs                    │");
    console.log("│    screenshots/     — page screenshots (PNG)                  │");
    console.log("│    summary.txt      — endpoint summary table                  │");
    console.log("│    js-sources.json  — JavaScript URLs found                   │");
    console.log("└──────────────────────────────────────────────────────────────┘");

    await context.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep running until Ctrl+C
  console.log("Recording... Press Ctrl+C to stop and save.\n");
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
