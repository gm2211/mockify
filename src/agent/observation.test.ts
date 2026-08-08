import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { ObservationRecorder, extractRecordableArgs } from './observation.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'observation-test-'));
}

function mockPage(overrides: Record<string, unknown> = {}) {
  let url = 'https://example.com/';
  const base = {
    url: () => url,
    title: async () => 'Test Page',
    locator: () => ({
      ariaSnapshot: async () => '- generic: body',
    }),
    setUrl: (u: string) => { url = u; },
  };
  return { ...base, ...overrides } as any;
}

function mockCollector(traffic: unknown[] = [], consoleLogs: unknown[] = []) {
  return {
    getTraffic: () => traffic,
    getConsoleLogs: () => consoleLogs,
  } as any;
}

test('extractRecordableArgs keeps only selector/url, never fill values or credentials', () => {
  const args = extractRecordableArgs({ selector: '#pw', value: 'hunter2', text: 'secret', url: 'https://x.test' });
  assert.deepEqual(args, { selector: '#pw', url: 'https://x.test' });
  assert.equal('value' in (args ?? {}), false);
  assert.equal('text' in (args ?? {}), false);
});

test('extractRecordableArgs returns undefined for empty/no args', () => {
  assert.equal(extractRecordableArgs(undefined), undefined);
  assert.equal(extractRecordableArgs({}), undefined);
  assert.equal(extractRecordableArgs({ delay: 50 }), undefined);
});

test('beginStep/endStep records a full step with ax snapshot written to disk', async () => {
  const dir = tmpDir();
  const page = mockPage();
  const collector = mockCollector();
  const recorder = new ObservationRecorder({ outputDir: dir, page, collector });

  await recorder.beginStep('click', { selector: '#submit' });
  await recorder.endStep({ success: true, screenshot: '/tmp/shot.png' });

  const steps = recorder.getSteps();
  assert.equal(steps.length, 1);
  const step = steps[0];
  assert.equal(step.step, 0);
  assert.equal(step.action, 'click');
  assert.deepEqual(step.args, { selector: '#submit' });
  assert.equal(step.success, true);
  assert.equal(step.title, 'Test Page');
  assert.equal(step.screenshot, '/tmp/shot.png');
  assert.ok('file' in step.ax, 'first ax snapshot should be written as a file, not deduped');
  if ('file' in step.ax) {
    const written = fs.readFileSync(path.join(dir, step.ax.file), 'utf-8');
    assert.equal(written, '- generic: body');
  }
});

test('step numbering increments across beginStep calls', async () => {
  const dir = tmpDir();
  const page = mockPage();
  const collector = mockCollector();
  const recorder = new ObservationRecorder({ outputDir: dir, page, collector });

  await recorder.beginStep('goto', { url: 'https://example.com/' });
  await recorder.endStep({ success: true });
  await recorder.beginStep('click', { selector: '#a' });
  await recorder.endStep({ success: true });

  const steps = recorder.getSteps();
  assert.deepEqual(steps.map((s) => s.step), [0, 1]);
});

test('ax snapshot dedups by digest: unchanged body is not re-written', async () => {
  const dir = tmpDir();
  const page = mockPage();
  const collector = mockCollector();
  const recorder = new ObservationRecorder({ outputDir: dir, page, collector });

  await recorder.beginStep('click', { selector: '#a' });
  await recorder.endStep({ success: true });
  await recorder.beginStep('click', { selector: '#b' });
  await recorder.endStep({ success: true });

  const steps = recorder.getSteps();
  assert.ok('file' in steps[0].ax);
  assert.ok('unchanged' in steps[1].ax);
  if ('unchanged' in steps[1].ax) {
    assert.equal(steps[1].ax.unchanged, true);
  }

  const axDir = path.join(dir, 'observations', 'ax');
  const files = fs.existsSync(axDir) ? fs.readdirSync(axDir) : [];
  assert.equal(files.length, 1, 'only the first (changed) snapshot should be written to disk');
});

test('mid-navigation ariaSnapshot failure is recorded, not thrown', async () => {
  const dir = tmpDir();
  const page = mockPage({
    locator: () => ({
      ariaSnapshot: async () => { throw new Error('Execution context was destroyed'); },
    }),
  });
  const collector = mockCollector();
  const recorder = new ObservationRecorder({ outputDir: dir, page, collector });

  await recorder.beginStep('goto', { url: 'https://example.com/next' });
  await recorder.endStep({ success: true });

  const steps = recorder.getSteps();
  assert.ok('error' in steps[0].ax);
  if ('error' in steps[0].ax) {
    assert.match(steps[0].ax.error, /Execution context was destroyed/);
  }
});

test('traffic/console ranges close lazily at the next beginStep, capturing late-arriving entries', async () => {
  const dir = tmpDir();
  const page = mockPage();
  const traffic: unknown[] = [{ url: 'https://example.com/api/1' }];
  const consoleLogs: unknown[] = [];
  const collector = mockCollector(traffic, consoleLogs);
  const recorder = new ObservationRecorder({ outputDir: dir, page, collector });

  await recorder.beginStep('click', { selector: '#a' });
  // Simulate a route handler's async response.text() landing *after* the
  // action's own promise resolved but *before* the next step begins.
  traffic.push({ url: 'https://example.com/api/2' });
  await recorder.endStep({ success: true });

  // Range end is not finalized yet — the step object was already pushed,
  // but its trafficRange[1] should still reflect start until closed.
  let step0 = recorder.getSteps()[0];
  assert.equal(step0.trafficRange[0], 1);
  assert.equal(step0.trafficRange[1], 1, 'range end stays open until next beginStep/save');

  // Another late arrival before the next step begins.
  traffic.push({ url: 'https://example.com/api/3' });

  await recorder.beginStep('click', { selector: '#b' });
  step0 = recorder.getSteps()[0];
  assert.equal(step0.trafficRange[1], 3, 'lazy close at next beginStep captures late-arriving entries');

  traffic.push({ url: 'https://example.com/api/4' });
  await recorder.endStep({ success: true });

  const result = recorder.save();
  const step1 = recorder.getSteps()[1];
  assert.equal(step1.trafficRange[0], 3);
  assert.equal(step1.trafficRange[1], 4, 'save() closes the final open range');
  assert.equal(result.steps, 2);

  const written = JSON.parse(fs.readFileSync(path.join(dir, 'observations.json'), 'utf-8'));
  assert.equal(written.length, 2);
});

test('save() writes observations.json even with zero steps', () => {
  const dir = tmpDir();
  const page = mockPage();
  const collector = mockCollector();
  const recorder = new ObservationRecorder({ outputDir: dir, page, collector });

  const result = recorder.save();
  assert.equal(result.steps, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'observations.json'), 'utf-8'));
  assert.deepEqual(written, []);
});

test('endStep records error and success:false for a failed action', async () => {
  const dir = tmpDir();
  const page = mockPage();
  const collector = mockCollector();
  const recorder = new ObservationRecorder({ outputDir: dir, page, collector });

  await recorder.beginStep('click', { selector: '#missing' });
  await recorder.endStep({ success: false, error: 'Element not found' });

  const step = recorder.getSteps()[0];
  assert.equal(step.success, false);
  assert.equal(step.error, 'Element not found');
});
