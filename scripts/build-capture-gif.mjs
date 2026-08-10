#!/usr/bin/env node
// Builds assets/agent-capture.gif from the real grok-driven capture run in
// captures/demo-grok/. Every screenshot pixel and every caption/tool-call
// value (step number, MCP tool name, selector/URL, cumulative request count)
// comes straight out of captures/demo-grok/observations.json — nothing here
// is staged or re-enacted.
//
// Requires: ImageMagick 7 (`magick` on PATH). Run with `node scripts/build-capture-gif.mjs`.

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CAPTURE_DIR = path.join(ROOT, "captures", "demo-grok");
const SCREENSHOT_DIR = path.join(CAPTURE_DIR, "screenshots");
const OBSERVATIONS_PATH = path.join(CAPTURE_DIR, "observations.json");
const OUTPUT_PATH = path.join(ROOT, "assets", "agent-capture.gif");
const FONT = "/System/Library/Fonts/Menlo.ttc";
const ORIGIN = "https://automationintesting.online";

// ---------------------------------------------------------------------------
// Layout: title strip (who's driving) -> agent tool-call pane -> screenshot
// ---------------------------------------------------------------------------

const FRAME_WIDTH = 1000;
const TITLE_HEIGHT = 44;
const PANE_HEADER_HEIGHT = 34;
const LOG_LINES = 7;
const LOG_LINE_HEIGHT = 22;
const LOG_START_Y = PANE_HEADER_HEIGHT + 18;
const TOOLPANE_HEIGHT = LOG_START_Y + LOG_LINES * LOG_LINE_HEIGHT + 16;
const BODY_HEIGHT = 560; // uniform crop/letterbox height for the screenshot area

const BG = "#0d1117";
const PANE_BG = "#010409";
const FG = "#c9d1d9";
const DIM = "#8b949e";
const DIM_OLD = "#454c56";
const ACCENT = {
  goto: "#58a6ff",
  click: "#3fb950",
  fill: "#d29922",
  screenshot: "#bc8cff",
  evaluate: "#6e7681",
};
const DEFAULT_ACCENT = "#8b949e";

const DELAY_NORMAL = 160; // centiseconds -> 1.6s
const DELAY_HOLD = 320; // centiseconds -> 3.2s

// ---------------------------------------------------------------------------
// Blank/spinner detection
//
// REGRESSION FIX: the previous script filtered spinner frames by sha1
// duplicate detection. That missed spinners that weren't byte-identical to
// another spinner — e.g. the frame linked from step 26, a
// `goto /reservation/2?checkin=...` that lands on a bare "Loading..." page.
// That was GIF frame 9/14 in the previously committed build.
//
// This version measures blankness instead. automationintesting.online
// renders a fixed ~56px dark Bootstrap navbar at the very top of every page
// (loaded or not); that bar's dark/light contrast dominates whole-image
// brightness/color stats enough to hide a blank body underneath it — a
// spinner-with-navbar frame measures ~92-95% mean brightness unmodified,
// the same range as real, content-bearing admin pages. Cropping that fixed
// bar off before measuring removes the confound: on the cropped image,
// every verified real spinner (with or without a navbar) lands at 66-275
// unique colors / 99.96-99.99% mean brightness, and every verified real
// content page lands at 347+ colors, or — if under 300 colors — under 99%
// mean. That's a clean, wide gap. Thresholds below were calibrated against
// every PNG in captures/demo-grok/screenshots/ and cross-checked by eye
// (see the printed table and the build report).
const NAV_CROP_PX = 56;
const BLANKISH_MAX_COLORS = 300;
const BLANKISH_MIN_MEAN = 99.5;

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
}

function magickOut(args) {
  return execFileSync("magick", args, { stdio: ["ignore", "pipe", "inherit"] })
    .toString()
    .trim();
}

function isBlankish(pngPath, workDir) {
  const cropped = path.join(workDir, `crop-${path.basename(pngPath)}`);
  run("magick", [pngPath, "-gravity", "North", "-chop", `0x${NAV_CROP_PX}`, cropped]);
  const colors = parseInt(magickOut([cropped, "-format", "%k", "info:"]), 10);
  const mean = parseFloat(magickOut([cropped, "-format", "%[fx:mean*100]", "info:"]));
  rmSync(cropped, { force: true });
  const reject = colors < BLANKISH_MAX_COLORS && mean > BLANKISH_MIN_MEAN;
  return { colors, mean, reject };
}

// Measures every screenshot in the capture directory and prints the
// (file, colors, mean, verdict) table the build must be verified against.
function buildBlankishTable(workDir) {
  const files = readdirSync(SCREENSHOT_DIR)
    .filter((f) => f.endsWith(".png"))
    .sort();
  const table = new Map();
  console.log("\nisBlankish verification (every screenshot in captures/demo-grok/screenshots/):");
  console.log(`  ${"file".padEnd(42)} ${"colors".padStart(7)} ${"mean%".padStart(8)}  verdict`);
  for (const file of files) {
    const result = isBlankish(path.join(SCREENSHOT_DIR, file), workDir);
    table.set(file, result);
    console.log(
      `  ${file.padEnd(42)} ${String(result.colors).padStart(7)} ${result.mean
        .toFixed(2)
        .padStart(8)}  ${result.reject ? "REJECT (blank/spinner)" : "ok"}`
    );
  }
  console.log("");
  return table;
}

// ---------------------------------------------------------------------------
// Frame plan
//
// observations.json has 46 step records from a real run against
// https://automationintesting.online. Steps whose `screenshot` field points
// at a file that exists on disk are the base candidate set (20 steps).
//
// Every candidate is run through isBlankish. Ten of the twenty turn out to
// be blank/spinner frames (not six, as the old sha1-based filter believed).
// For each rejected step we look for the nearest real, settled screenshot
// for the SAME navigation (matched by urlAfter) elsewhere in
// captures/demo-grok/screenshots/, and substitute it if it also passes
// isBlankish. A step is only dropped if no such substitute exists anywhere
// in the run's screenshots — true for five of the ten: the run simply never
// captured a settled frame for those navigations (/reservation/2
// double-room, /admin/report, /admin/branding, /reservation/3 suite,
// /cookie all only ever produced spinner pixels in this capture).
//
// SUBSTITUTE picks the *nearest* passing same-navigation file by file
// index, with one deliberate exception: step 28 (`goto /`) would otherwise
// reuse 022-click-not__w-100__not__btn-lg_.png, which is the very next kept
// frame (step 31's own screenshot) — showing the identical image twice in a
// row would read as the GIF freezing. 002-01-home.png is the same
// navigation (root `/`) and still 100% real, just a few frames further back
// in the same run, so it's used instead.
const CANDIDATE_STEPS = [
  0, 4, 6, 9, 12, 17, 19, 22, 26, 28, 31, 39, 49, 53, 54, 57, 59, 61, 70, 72,
];

// Steps 43 and 48 are manual `browser_screenshot` calls (action:
// "screenshot") with no `screenshot` field recorded in observations.json —
// but the same real capture run also wrote two settled, unlinked
// screenshots for exactly this point in the flow (form submitted, then
// success message). Defect 3 explicitly calls for a "contact submitted"
// payoff frame that the old 14-frame build never had at all (it jumped
// straight from the filled contact form to the admin login). These are
// pulled in under the same rules as everything else: real pixels from this
// run, verified isBlankish, captioned from the real observation record for
// that step.
const EXTRA_STEPS = {
  43: "030-11-contact-submitted.png",
  48: "031-12-contact-success.png",
};

const SUBSTITUTE = {
  0: "002-01-home.png",
  6: "006-03-room-detail-single.png",
  28: "002-01-home.png",
  54: "037-14-admin-after-login.png",
  61: "043-17-admin-messages.png",
};

// Payoff frames: booking form filled, booking confirmed, contact submitted
// (+ its success follow-up), admin panel.
const HOLD_STEPS = new Set([19, 22, 43, 48, 54]);

// The contact-flow screenshots (022, 024, 030, 031) are full-page captures
// of the homepage — the contact form and its validation/success state sit
// well below the fold, with the same hero banner on top every time. The
// default top-anchored crop (see buildBody) would show that identical hero
// for all four frames and hide the one thing each of these steps is
// actually there to show. Bottom-anchoring the crop for just these steps
// surfaces the real payoff (validation errors narrowing, then the "Thanks
// for getting in touch" success message) instead.
const SOUTH_CROP_STEPS = new Set([31, 39, 43, 48]);

// Mirrors src/mcp/server.ts BROWSER_TOOL_DEFS.
const TOOL_NAMES = {
  goto: "browser_goto",
  click: "browser_click",
  fill: "browser_fill",
  type: "browser_type",
  selectOption: "browser_select",
  hover: "browser_hover",
  press: "browser_press",
  screenshot: "browser_screenshot",
  content: "browser_content",
  evaluate: "browser_evaluate",
  url: "browser_url",
  title: "browser_title",
  waitForSelector: "browser_wait_for",
};

function shortenUrl(url) {
  if (url === ORIGIN || url === `${ORIGIN}/`) return "/";
  return url.startsWith(ORIGIN) ? url.slice(ORIGIN.length) : url;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Renders one observation as a real MCP tool call, e.g.
//   browser_click     { selector: "button.btn-primary.w-100.mb-3" }
function renderCall(obs) {
  const tool = TOOL_NAMES[obs.action] ?? `browser_${obs.action}`;
  let args;
  switch (obs.action) {
    case "goto":
      args = `{ url: "${truncate(shortenUrl(obs.args.url), 68)}" }`;
      break;
    case "click":
    case "hover":
    case "press":
    case "fill":
    case "type":
    case "selectOption":
      args = `{ selector: "${truncate(obs.args?.selector ?? "", 68)}" }`;
      break;
    default:
      args = "()";
  }
  return `${tool.padEnd(17)}${args}`;
}

function loadFramePlan(blankTable) {
  const observations = JSON.parse(readFileSync(OBSERVATIONS_PATH, "utf8"));
  const byStep = new Map(observations.map((o) => [o.step, o]));

  // Full chronological call log (all 46 steps) for the accumulating
  // tool-call pane — includes evaluate/screenshot steps with no frame of
  // their own, so the history reads like a real trace, not just the steps
  // that happen to have a picture.
  const callLog = observations
    .slice()
    .sort((a, b) => a.step - b.step)
    .map((obs) => ({ step: obs.step, action: obs.action, text: renderCall(obs) }));
  const callLogIndex = new Map(callLog.map((c, i) => [c.step, i]));

  const steps = [...CANDIDATE_STEPS, ...Object.keys(EXTRA_STEPS).map(Number)].sort(
    (a, b) => a - b
  );

  const plan = [];
  const dropped = [];

  for (const step of steps) {
    const obs = byStep.get(step);
    const linkedFile = EXTRA_STEPS[step] ?? path.basename(obs.screenshot);
    const linkedResult = blankTable.get(linkedFile);
    if (!linkedResult) throw new Error(`No blankish measurement for ${linkedFile}`);

    let chosenFile = linkedFile;
    if (linkedResult.reject) {
      const sub = SUBSTITUTE[step];
      const subResult = sub && blankTable.get(sub);
      if (sub && subResult && !subResult.reject) {
        chosenFile = sub;
      } else {
        dropped.push({
          step,
          linkedFile,
          reason: `blank/spinner and no passing substitute exists for this navigation (${shortenUrl(
            obs.urlAfter
          )})`,
        });
        continue;
      }
    }

    const screenshotPath = path.join(SCREENSHOT_DIR, chosenFile);
    if (!existsSync(screenshotPath)) {
      throw new Error(`Missing screenshot for step ${step}: ${screenshotPath}`);
    }

    const idx = callLogIndex.get(step);
    const historyStart = Math.max(0, idx - (LOG_LINES - 1));
    const history = callLog.slice(historyStart, idx + 1).map((c, i, arr) => ({
      text: c.text,
      current: i === arr.length - 1,
    }));

    plan.push({
      step,
      action: obs.action,
      screenshotFile: chosenFile,
      screenshotPath,
      substituted: chosenFile !== linkedFile,
      requests: Array.isArray(obs.trafficRange) ? obs.trafficRange[1] : null,
      hold: HOLD_STEPS.has(step),
      cropGravity: SOUTH_CROP_STEPS.has(step) ? "South" : "North",
      history,
    });
  }

  return { plan, dropped };
}

// ---------------------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, "0");
}

function buildTitle(workDir) {
  const titlePath = path.join(workDir, "title.png");
  run("magick", [
    "-size",
    `${FRAME_WIDTH}x${TITLE_HEIGHT}`,
    `xc:${BG}`,
    "-fill",
    "#58a6ff",
    "-draw",
    `rectangle 0,${TITLE_HEIGHT - 2} ${FRAME_WIDTH},${TITLE_HEIGHT}`,
    "-font",
    FONT,
    "-pointsize",
    "19",
    "-fill",
    FG,
    "-gravity",
    "West",
    "-annotate",
    "+26+0",
    "grok → mockify MCP",
    "-pointsize",
    "14",
    "-fill",
    DIM,
    "-gravity",
    "East",
    "-annotate",
    "+26+0",
    "capture session: automationintesting.online",
    titlePath,
  ]);
  return titlePath;
}

function lerpColor(from, to, t) {
  const f = from.match(/\w\w/g).map((h) => parseInt(h, 16));
  const tt = to.match(/\w\w/g).map((h) => parseInt(h, 16));
  const c = f.map((v, i) => Math.round(v + (tt[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// Agent tool-call stream pane: last ~7 calls, accumulating from the bottom
// slot upward so the current call always sits in the same place frame to
// frame and older lines fade toward the top.
function buildPane(frame, index, total, workDir) {
  const panePath = path.join(workDir, `pane-${pad2(index + 1)}.png`);
  const accent = ACCENT[frame.action] ?? DEFAULT_ACCENT;

  const args = [
    "-size",
    `${FRAME_WIDTH}x${TOOLPANE_HEIGHT}`,
    `xc:${PANE_BG}`,
    "-fill",
    accent,
    "-draw",
    `rectangle 0,0 6,${TOOLPANE_HEIGHT}`,
    "-font",
    FONT,
    "-pointsize",
    "19",
    "-fill",
    accent,
    "-gravity",
    "NorthWest",
    "-annotate",
    "+26+14",
    `STEP ${pad2(index + 1)}/${pad2(total)}`,
  ];

  if (frame.requests != null) {
    args.push(
      "-pointsize",
      "14",
      "-fill",
      DIM,
      "-gravity",
      "NorthEast",
      "-annotate",
      "+24+20",
      `requests: ${frame.requests}`
    );
  }

  const startSlot = LOG_LINES - frame.history.length;
  frame.history.forEach((line, i) => {
    const slot = startSlot + i;
    const y = LOG_START_Y + slot * LOG_LINE_HEIGHT;
    let color;
    if (line.current) {
      color = accent;
    } else {
      const age = frame.history.length - 1 - i; // 1 = most recent history line
      const t = Math.min(1, age / Math.max(1, frame.history.length - 1));
      color = lerpColor(DIM, DIM_OLD, t);
    }
    const prefix = line.current ? "▶ " : "  ";
    args.push(
      "-pointsize",
      "14.5",
      "-fill",
      color,
      "-gravity",
      "NorthWest",
      "-annotate",
      `+26+${y}`,
      truncate(`${prefix}${line.text}`, 96)
    );
  });

  args.push(panePath);
  run("magick", args);
  return panePath;
}

function buildBody(frame, index, workDir) {
  const bodyPath = path.join(workDir, `body-${pad2(index + 1)}.png`);
  // Screenshot -> uniform width, then crop/letterbox to a fixed height so
  // frames never jitter in size even though source screenshots range from
  // 1440x900 (marketing pages) to 1440x4112 (full-page homepage renders).
  // Gravity is North (top-anchored) by default; SOUTH_CROP_STEPS uses South
  // instead for the handful of full-page homepage screenshots whose
  // relevant content (the contact form / its result) is at the bottom, not
  // under the hero banner at the top — see SOUTH_CROP_STEPS above.
  run("magick", [
    frame.screenshotPath,
    "-resize",
    `${FRAME_WIDTH}x`,
    "-gravity",
    frame.cropGravity,
    "-background",
    BG,
    "-extent",
    `${FRAME_WIDTH}x${BODY_HEIGHT}`,
    bodyPath,
  ]);
  return bodyPath;
}

function buildFrame(frame, index, total, titlePath, workDir) {
  const panePath = buildPane(frame, index, total, workDir);
  const bodyPath = buildBody(frame, index, workDir);
  const framePath = path.join(workDir, `frame-${pad2(index + 1)}.png`);

  // Stack title -> tool-call pane -> screenshot. `+repage` resets the
  // virtual canvas/page geometry `-append` otherwise leaves behind —
  // without it, `magick -layers Optimize` at assembly time misreads every
  // frame's canvas and the GIF collapses to a sliver.
  run("magick", [titlePath, panePath, bodyPath, "-append", "+repage", framePath]);

  return { framePath, delay: frame.hold ? DELAY_HOLD : DELAY_NORMAL };
}

// ---------------------------------------------------------------------------

function main() {
  const workDir = mkdtempSync(path.join(tmpdir(), "agent-capture-gif-"));
  try {
    const blankTable = buildBlankishTable(workDir);
    const { plan, dropped } = loadFramePlan(blankTable);
    if (plan.length === 0) throw new Error("No eligible frames found");

    const titlePath = buildTitle(workDir);
    const rendered = plan.map((frame, index) =>
      buildFrame(frame, index, plan.length, titlePath, workDir)
    );

    mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

    const assembleArgs = [];
    for (const { framePath, delay } of rendered) {
      assembleArgs.push("-delay", String(delay), framePath);
    }
    assembleArgs.push("-loop", "0", "-layers", "Optimize", "-colors", "192", OUTPUT_PATH);
    run("magick", assembleArgs);

    console.log(`Wrote ${OUTPUT_PATH}`);
    console.log(`Frames: ${plan.length}`);
    let totalCs = 0;
    for (const f of plan) totalCs += f.hold ? DELAY_HOLD : DELAY_NORMAL;
    console.log(`Approx total duration: ${(totalCs / 100).toFixed(1)}s`);
    console.log("");
    console.log("Frame plan:");
    plan.forEach((f, i) => {
      const current = f.history[f.history.length - 1].text;
      console.log(
        `  frame ${pad2(i + 1)} (obs #${f.step}): ${current} | screenshot=${f.screenshotFile}${
          f.substituted ? " [substituted]" : ""
        }${f.hold ? " [HOLD]" : ""}`
      );
    });
    if (dropped.length) {
      console.log("\nDropped candidate steps:");
      for (const d of dropped) {
        console.log(`  step ${d.step} (${d.linkedFile}): ${d.reason}`);
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main();
