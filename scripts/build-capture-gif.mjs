#!/usr/bin/env node
// Builds assets/agent-capture.gif from the real grok-driven capture run in
// captures/demo-grok/. Every screenshot pixel and every caption value
// (step number, action, target, cumulative request count) comes straight
// out of captures/demo-grok/observations.json — nothing here is staged or
// re-enacted.
//
// Requires: ImageMagick 7 (`magick` on PATH). Run with `node scripts/build-capture-gif.mjs`.

import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
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

const FRAME_WIDTH = 1000;
const BODY_HEIGHT = 640; // uniform crop/letterbox height for the screenshot area
const CAPTION_HEIGHT = 130;
const BG = "#0d1117";
const FG = "#c9d1d9";
const DIM = "#8b949e";
const ACCENT = {
  goto: "#58a6ff",
  click: "#3fb950",
  fill: "#d29922",
};
const DELAY_NORMAL = 80; // centiseconds -> 0.8s
const DELAY_HOLD = 180; // centiseconds -> 1.8s

// ---------------------------------------------------------------------------
// Frame plan
//
// observations.json has 46 step records from a real run against
// https://automationintesting.online. Only steps whose `screenshot` field
// points at a file that actually exists on disk are eligible (goto/click/fill
// steps get a screenshot; evaluate/bare-screenshot steps mostly don't).
//
// That yields 20 candidate steps. Two problems showed up on inspection:
//
// 1. Six of those steps have a screenshot that is a bare "Loading..." spinner
//    frame, captured mid-navigation before the page settled (a timing quirk
//    in the capture pipeline, confirmed by sha1: several are byte-identical
//    across unrelated steps, e.g. steps 6/28/72 all share one spinner image;
//    steps 54/59/61 share another). A spinner carries no information and
//    would just look broken repeated on screen, so those steps are dropped:
//    steps 28, 57, 59, 61, 70, 72.
//
// 2. Three more steps (0, 6, 54) *also* only have a spinner screenshot linked
//    in observations.json, but the capture run additionally wrote a
//    differently-named, non-linked screenshot for the same navigation that
//    shows the actual settled page (e.g. `002-01-home.png` next to the
//    spinner `001-initial.png` for step 0). Those are real frames from the
//    same real run, just not the ones observations.json happened to link —
//    the substitution table below swaps in the settled screenshot while
//    every caption value (step number, action, selector/URL, request count)
//    still comes from the real observation record for that step.
const DROP_STEPS = new Set([28, 57, 59, 61, 70, 72]);

const SCREENSHOT_OVERRIDE = {
  0: "002-01-home.png", // linked 001-initial.png is the pre-render spinner
  6: "006-03-room-detail-single.png", // linked 004-02-check-availability.png is the spinner
  54: "037-14-admin-after-login.png", // linked 036-click-page.png is the spinner
};

const HOLD_STEPS = new Set([19, 22, 54]); // booking form filled / booking confirmed / admin panel

const ORIGIN = "https://automationintesting.online";

function shortenUrl(url) {
  if (url === ORIGIN || url === `${ORIGIN}/`) return "/";
  return url.startsWith(ORIGIN) ? url.slice(ORIGIN.length) : url;
}

function truncate(text, max = 78) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function loadFramePlan() {
  const observations = JSON.parse(readFileSync(OBSERVATIONS_PATH, "utf8"));
  const byStep = new Map(observations.map((o) => [o.step, o]));

  const candidateSteps = observations
    .filter((o) => o.screenshot && existsSync(o.screenshot))
    .map((o) => o.step)
    .filter((step) => !DROP_STEPS.has(step))
    .sort((a, b) => a - b);

  return candidateSteps.map((step, index) => {
    const obs = byStep.get(step);
    const action = obs.action;
    const target =
      action === "goto" ? shortenUrl(obs.args.url) : obs.args?.selector ?? "";
    const screenshotFile = SCREENSHOT_OVERRIDE[step] ?? path.basename(obs.screenshot);
    const screenshotPath = path.join(SCREENSHOT_DIR, screenshotFile);
    if (!existsSync(screenshotPath)) {
      throw new Error(`Missing screenshot for step ${step}: ${screenshotPath}`);
    }
    const requests = Array.isArray(obs.trafficRange) ? obs.trafficRange[1] : null;

    return {
      step,
      index, // 0-based position in the final frame sequence
      action,
      target,
      requests,
      screenshotPath,
      hold: HOLD_STEPS.has(step),
    };
  });
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
}

function buildFrame(frame, total, workDir) {
  const num = String(frame.index + 1).padStart(2, "0");
  const totalStr = String(total).padStart(2, "0");
  const bodyPath = path.join(workDir, `body-${num}.png`);
  const capPath = path.join(workDir, `cap-${num}.png`);
  const framePath = path.join(workDir, `frame-${num}.png`);

  // 1. Screenshot -> uniform width, top-anchored crop/letterbox so frames
  //    never jitter in size even though source screenshots range from
  //    1440x900 (marketing pages) to 1440x2170 (long booking pages).
  run("magick", [
    frame.screenshotPath,
    "-resize",
    `${FRAME_WIDTH}x`,
    "-gravity",
    "North",
    "-background",
    BG,
    "-extent",
    `${FRAME_WIDTH}x${BODY_HEIGHT}`,
    bodyPath,
  ]);

  // 2. HUD caption bar with real recorded data for this step.
  const accent = ACCENT[frame.action] ?? DIM;
  const headline = `STEP ${num}/${totalStr}  ${frame.action.toUpperCase()}`;
  const targetLine = truncate(`-> ${frame.target}`);
  const reqLine = frame.requests != null ? `requests: ${frame.requests}` : "";

  const drawArgs = [
    "-size",
    `${FRAME_WIDTH}x${CAPTION_HEIGHT}`,
    `xc:${BG}`,
    "-fill",
    accent,
    "-draw",
    `rectangle 0,0 6,${CAPTION_HEIGHT}`,
    "-font",
    FONT,
    "-pointsize",
    "23",
    "-fill",
    accent,
    "-gravity",
    "NorthWest",
    "-annotate",
    "+26+20",
    headline,
    "-pointsize",
    "18",
    "-fill",
    FG,
    "-gravity",
    "NorthWest",
    "-annotate",
    "+26+68",
    targetLine,
  ];
  if (reqLine) {
    drawArgs.push(
      "-pointsize",
      "15",
      "-fill",
      DIM,
      "-gravity",
      "NorthEast",
      "-annotate",
      "+24+28",
      reqLine
    );
  }
  drawArgs.push(capPath);
  run("magick", drawArgs);

  // 3. Stack caption above the screenshot body. `+repage` resets the
  //    virtual canvas/page geometry that `-append` otherwise leaves behind
  //    (inherited from the 1000x130 caption canvas) — without it, `magick
  //    -layers Optimize` at assembly time misreads every frame's canvas as
  //    1000x130 and the GIF collapses to a sliver.
  run("magick", [capPath, bodyPath, "-append", "+repage", framePath]);

  return { framePath, delay: frame.hold ? DELAY_HOLD : DELAY_NORMAL };
}

function main() {
  const plan = loadFramePlan();
  if (plan.length === 0) throw new Error("No eligible frames found");

  const workDir = mkdtempSync(path.join(tmpdir(), "agent-capture-gif-"));
  try {
    const rendered = plan.map((frame) => buildFrame(frame, plan.length, workDir));

    mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

    const assembleArgs = [];
    for (const { framePath, delay } of rendered) {
      assembleArgs.push("-delay", String(delay), framePath);
    }
    assembleArgs.push("-loop", "0", "-layers", "Optimize", "-colors", "192", OUTPUT_PATH);
    run("magick", assembleArgs);

    console.log(`Wrote ${OUTPUT_PATH}`);
    console.log(`Frames: ${plan.length}`);
    for (const f of plan) {
      console.log(
        `  step ${String(f.index + 1).padStart(2, "0")} (obs #${f.step}): ${f.action} ${f.target} [${
          f.hold ? "HOLD" : "normal"
        }]`
      );
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main();
