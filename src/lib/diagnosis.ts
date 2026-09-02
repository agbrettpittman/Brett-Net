/** Mirrors `diag::StepKind`. */
export type StepKind = 'adapters' | 'gateway' | 'internet' | 'host' | 'service' | 'path';

/** Mirrors `diag::StepOutcome`. */
export type StepOutcome = 'pass' | 'fail' | 'skipped' | 'unsupported';

export interface DiagStep {
  kind: StepKind;
  label: string;
  outcome: StepOutcome;
  detail: string;
}

/** Mirrors `diag::Conclusion`. */
export type Conclusion =
  | 'noNetwork'
  | 'localNetwork'
  | 'upstreamDown'
  | 'hostUnreachable'
  | 'serviceGone'
  | 'filtered'
  | 'recovered'
  | 'inconclusive';

export interface DiagReport {
  watchId: string;
  label: string;
  at: number;
  /** `host:port`, or null when the watch had no peer to probe. */
  target: string | null;
  /** True when the user asked for it rather than a drop triggering it. */
  manual: boolean;
  steps: DiagStep[];
  conclusion: Conclusion;
}

/**
 * Mirrors `diag::DiagEvent`.
 *
 * Tagged `event` rather than `kind` — a step carries a `kind` of its own, and
 * one field cannot be both.
 */
export type DiagEvent =
  | {
      event: 'started';
      watchId: string;
      label: string;
      target: string | null;
      at: number;
      manual: boolean;
    }
  | { event: 'step'; step: DiagStep }
  | { event: 'done'; report: DiagReport };

export const CONCLUSION_LABEL: Record<Conclusion, string> = {
  noNetwork: 'No network',
  localNetwork: 'Local network down',
  upstreamDown: 'Internet down',
  hostUnreachable: 'Host unreachable',
  serviceGone: 'Service gone',
  filtered: 'Blocked',
  recovered: 'Recovered',
  inconclusive: 'No fault found',
};

/**
 * One line saying what to do about it.
 *
 * The conclusion names what is wrong; this names whose problem it is, which is
 * the only reason anyone reads a diagnosis.
 */
export const CONCLUSION_SUMMARY: Record<Conclusion, string> = {
  noNetwork: 'This machine is off the network — check the cable or Wi-Fi.',
  localNetwork: 'Neither the router nor the internet answered, so the fault is on this side of it.',
  upstreamDown: 'The router answered but the internet did not, so the fault is upstream.',
  hostUnreachable: 'The network is fine, but the far end is not answering.',
  serviceGone: 'The host is up and refusing connections, so the service itself stopped.',
  filtered: 'The host is reachable, but something is blocking this connection.',
  recovered: 'It connects again now, so the drop was transient.',
  inconclusive: 'Everything that could be tested was healthy.',
};

/** Whether the conclusion points at a fault worth acting on. */
export function isProblem(conclusion: Conclusion): boolean {
  return conclusion !== 'recovered' && conclusion !== 'inconclusive';
}

/** Which side of the network a conclusion puts the blame on, for grouping. */
export function blame(conclusion: Conclusion): 'here' | 'between' | 'there' | 'none' {
  switch (conclusion) {
    case 'noNetwork':
    case 'localNetwork':
      return 'here';
    case 'upstreamDown':
    case 'filtered':
      return 'between';
    case 'hostUnreachable':
    case 'serviceGone':
      return 'there';
    default:
      return 'none';
  }
}

export const OUTCOME_MARK: Record<StepOutcome, string> = {
  pass: '✓',
  fail: '✕',
  skipped: '–',
  unsupported: '–',
};

/** A diagnosis in progress, or the report it finished as. */
export interface DiagRun {
  watchId: string;
  label: string;
  target: string | null;
  at: number;
  manual: boolean;
  steps: DiagStep[];
  /** Null while it is still running. */
  conclusion: Conclusion | null;
}

/**
 * Folds one streamed event into the run in flight.
 *
 * A pure reducer so the panel can be driven straight off the event stream, and
 * so the ordering rules — a `started` replaces, a `step` appends, a `done`
 * settles — are testable without a network.
 */
export function applyDiagEvent(current: DiagRun | null, event: DiagEvent): DiagRun | null {
  switch (event.event) {
    case 'started':
      return {
        watchId: event.watchId,
        label: event.label,
        target: event.target,
        at: event.at,
        manual: event.manual,
        steps: [],
        conclusion: null,
      };
    case 'step':
      // A step with no start behind it means the UI reloaded mid-diagnosis.
      // Dropping it is better than inventing a run with no label.
      return current === null ? null : { ...current, steps: [...current.steps, event.step] };
    case 'done':
      return {
        watchId: event.report.watchId,
        label: event.report.label,
        target: event.report.target,
        at: event.report.at,
        manual: event.report.manual,
        steps: event.report.steps,
        conclusion: event.report.conclusion,
      };
  }
}

/** Reports for one watch, newest first. */
export function reportsFor(reports: DiagReport[], watchId: string): DiagReport[] {
  return reports.filter((r) => r.watchId === watchId).sort((a, b) => b.at - a.at);
}
