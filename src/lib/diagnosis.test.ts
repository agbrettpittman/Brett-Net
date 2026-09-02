import { describe, expect, it } from 'vitest';
import {
  applyDiagEvent,
  blame,
  CONCLUSION_LABEL,
  CONCLUSION_SUMMARY,
  isProblem,
  OUTCOME_MARK,
  reportsFor,
  type Conclusion,
  type DiagReport,
  type DiagStep,
} from './diagnosis';

const ALL: Conclusion[] = [
  'noNetwork',
  'localNetwork',
  'upstreamDown',
  'hostUnreachable',
  'serviceGone',
  'filtered',
  'recovered',
  'inconclusive',
];

const step = (over: Partial<DiagStep> = {}): DiagStep => ({
  kind: 'gateway',
  label: 'Default gateway',
  outcome: 'pass',
  detail: 'Ethernet 192.168.1.1 in 1.2 ms.',
  ...over,
});

const report = (over: Partial<DiagReport> = {}): DiagReport => ({
  watchId: 'w1',
  label: 'chrome.exe → 1.1.1.1:443',
  at: 1_000,
  target: '1.1.1.1:443',
  manual: false,
  steps: [step()],
  conclusion: 'hostUnreachable',
  ...over,
});

describe('labels', () => {
  it('names every conclusion the backend can produce', () => {
    for (const c of ALL) {
      expect(CONCLUSION_LABEL[c]).toBeTruthy();
      expect(CONCLUSION_SUMMARY[c]).toBeTruthy();
    }
  });

  it('marks every outcome', () => {
    expect(Object.keys(OUTCOME_MARK).sort()).toEqual([
      'fail',
      'pass',
      'skipped',
      'unsupported',
    ]);
  });
});

describe('isProblem', () => {
  it('treats a recovery and a clean bill of health as no fault', () => {
    expect(isProblem('recovered')).toBe(false);
    expect(isProblem('inconclusive')).toBe(false);
  });

  it('treats everything else as one', () => {
    for (const c of ALL.filter((x) => x !== 'recovered' && x !== 'inconclusive')) {
      expect(isProblem(c)).toBe(true);
    }
  });
});

describe('blame', () => {
  it('puts each conclusion on the right side of the network', () => {
    expect(blame('noNetwork')).toBe('here');
    expect(blame('localNetwork')).toBe('here');
    expect(blame('upstreamDown')).toBe('between');
    expect(blame('filtered')).toBe('between');
    expect(blame('hostUnreachable')).toBe('there');
    expect(blame('serviceGone')).toBe('there');
    expect(blame('recovered')).toBe('none');
  });

  it('has an answer for every conclusion', () => {
    for (const c of ALL) expect(blame(c)).toBeTruthy();
  });
});

describe('applyDiagEvent', () => {
  it('starts a run with no steps and no conclusion', () => {
    const run = applyDiagEvent(null, {
      event: 'started',
      watchId: 'w1',
      label: 'chrome.exe → 1.1.1.1:443',
      target: '1.1.1.1:443',
      at: 5,
      manual: true,
    });

    expect(run).toMatchObject({ watchId: 'w1', steps: [], conclusion: null, manual: true });
  });

  it('appends rungs in the order they arrive', () => {
    let run = applyDiagEvent(null, {
      event: 'started',
      watchId: 'w1',
      label: 'x',
      target: null,
      at: 5,
      manual: false,
    });
    run = applyDiagEvent(run, { event: 'step', step: step({ kind: 'adapters' }) });
    run = applyDiagEvent(run, { event: 'step', step: step({ kind: 'gateway' }) });

    expect(run?.steps.map((s) => s.kind)).toEqual(['adapters', 'gateway']);
  });

  it('does not treat the previous run as the current one', () => {
    // Each start replaces, so a second diagnosis never shows the first one's
    // rungs above its own.
    let run = applyDiagEvent(null, {
      event: 'started',
      watchId: 'w1',
      label: 'x',
      target: null,
      at: 5,
      manual: false,
    });
    run = applyDiagEvent(run, { event: 'step', step: step() });
    run = applyDiagEvent(run, {
      event: 'started',
      watchId: 'w2',
      label: 'y',
      target: null,
      at: 9,
      manual: false,
    });

    expect(run).toMatchObject({ watchId: 'w2', steps: [] });
  });

  it('ignores a rung with no run behind it', () => {
    // What a UI reload mid-diagnosis looks like. Inventing a run with no label
    // would be worse than missing the first rungs.
    expect(applyDiagEvent(null, { event: 'step', step: step() })).toBeNull();
  });

  it('settles on the report, which is authoritative over the streamed rungs', () => {
    let run = applyDiagEvent(null, {
      event: 'started',
      watchId: 'w1',
      label: 'x',
      target: null,
      at: 5,
      manual: false,
    });
    run = applyDiagEvent(run, { event: 'step', step: step() });
    run = applyDiagEvent(run, { event: 'done', report: report({ steps: [step(), step()] }) });

    expect(run?.conclusion).toBe('hostUnreachable');
    expect(run?.steps).toHaveLength(2);
  });

  it('shows a report that arrives without its start', () => {
    // The reload case again, at the other end: the finished report has
    // everything needed to render, so it stands on its own.
    const run = applyDiagEvent(null, { event: 'done', report: report() });
    expect(run).toMatchObject({ watchId: 'w1', conclusion: 'hostUnreachable' });
  });
});

describe('reportsFor', () => {
  it('keeps one watch and puts the newest first', () => {
    const mine = [report({ at: 1 }), report({ at: 3 }), report({ at: 2 })];
    const theirs = report({ watchId: 'w2', at: 9 });

    expect(reportsFor([...mine, theirs], 'w1').map((r) => r.at)).toEqual([3, 2, 1]);
  });

  it('is empty for a watch that has never been diagnosed', () => {
    expect(reportsFor([report()], 'nope')).toEqual([]);
  });
});
