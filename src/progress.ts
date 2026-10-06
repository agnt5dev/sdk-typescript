/**
 * `ctx.progress`: report how far a run has got.
 *
 * A report is a `progress.update` record in the run's journal. Studio and
 * `get_run` show the latest one, and an MCP client that called the run's
 * tool with a progress token hears each one as `notifications/progress`.
 *
 * Reports are side-band: nothing reads them back into the run, so they can't
 * change what a workflow does when it replays. They are cheap to make often:
 * each run writes at most one record a second, always the latest report, and
 * sends it without holding up the run. The latest report is always written
 * before the run finishes. Progress never goes backwards, as MCP requires:
 * within an execution the SDK drops a report below the last one, and across
 * executions of a run the runtime ignores one.
 */

/** What `ctx.progress(progress, options)` takes besides how far. */
export interface ProgressOptions {
  /** What `progress` counts towards, when known. A positive number. */
  total?: number;
  /** What the run is doing now. */
  message?: string;
}

/** One report, as its journal record carries it. */
export interface ProgressReport {
  progress: number;
  total?: number;
  message?: string;
}

/** The shortest time between two progress records of one run. */
export const PROGRESS_INTERVAL_MS = 1000;

/** The longest message a report keeps. */
export const MAX_PROGRESS_MESSAGE_CHARS = 1000;

function describe(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

function finiteNumber(name: string, value: unknown): number {
  if (typeof value !== 'number') {
    throw new TypeError(`ctx.progress: ${name} must be a number, got ${describe(value)}`);
  }
  if (!Number.isFinite(value)) {
    throw new RangeError(`ctx.progress: ${name} must be finite, got ${value}`);
  }
  return value;
}

/**
 * Check a report. Throws `TypeError` for a `progress` or `total` that isn't a
 * number or a `message` that isn't a string, and `RangeError` for a value
 * that isn't finite or a `total` that isn't positive.
 */
export function progressReport(progress: number, options: ProgressOptions = {}): ProgressReport {
  const report: ProgressReport = { progress: finiteNumber('progress', progress) };
  // Only `undefined` leaves an option out; `null` is a value, and not a valid one.
  if (options.total !== undefined) {
    const total = finiteNumber('total', options.total);
    if (total <= 0) {
      throw new RangeError(`ctx.progress: total must be positive, got ${total}`);
    }
    report.total = total;
  }
  if (options.message !== undefined) {
    if (typeof options.message !== 'string') {
      throw new TypeError(`ctx.progress: message must be a string, got ${describe(options.message)}`);
    }
    if (options.message) {
      report.message = options.message.slice(0, MAX_PROGRESS_MESSAGE_CHARS);
    }
  }
  return report;
}

function sameReport(a: ProgressReport, b: ProgressReport): boolean {
  return a.progress === b.progress && a.total === b.total && a.message === b.message;
}

/**
 * Coalesces one run's reports into at most one record per interval.
 *
 * `report` never blocks. The first report is handed to `send` at once, in
 * the same call; later ones wait out the interval and only the latest is
 * sent. Each report travels with its `source` (where it sits in the event
 * tree), kept only when the report is accepted. `drain` hands over the
 * report still waiting and stops the reporter: call it before the run ends.
 *
 * The never-backwards filter covers this reporter's reports, one execution
 * of a run. Across executions (a retry, a resumed workflow) the runtime
 * enforces it: the MCP edge and `get_run` ignore a report below the run's
 * last figure.
 */
export class ProgressReporter<S = undefined> {
  private last?: ProgressReport;
  private pending?: { report: ProgressReport; source: S };
  private timer?: ReturnType<typeof setTimeout>;
  private sending = false;
  private nextAt = 0;
  private closed = false;

  constructor(
    private readonly send: (report: ProgressReport, source: S) => Promise<void>,
    private readonly intervalMs: number = PROGRESS_INTERVAL_MS,
  ) {}

  /** Queue a report. False when it was dropped: it went backwards, repeated
   * the last one, or the run has finished. */
  report(report: ProgressReport, source?: S): boolean {
    if (this.closed) return false;
    if (this.last && (report.progress < this.last.progress || sameReport(report, this.last))) {
      return false;
    }
    this.last = report;
    this.pending = { report, source: source as S };
    this.schedule();
    return true;
  }

  /** Hand over the report still waiting, if any, and stop. */
  drain(): void {
    if (this.closed) return;
    const pending = this.pending;
    this.stop();
    if (pending) void this.deliver(pending);
  }

  /** Stop without sending what is waiting. */
  close(): void {
    this.stop();
  }

  private stop(): void {
    this.closed = true;
    this.pending = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    if (this.timer || this.sending || !this.pending || this.closed) return;
    const delay = this.nextAt - Date.now();
    if (delay <= 0) {
      // Nothing sent lately: send now, before the caller can return and
      // end the run.
      void this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
    // A pending report must never keep the process alive.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async flush(): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || this.closed) return;
    this.sending = true;
    this.nextAt = Date.now() + this.intervalMs;
    try {
      await this.deliver(pending);
    } finally {
      this.sending = false;
      this.schedule();
    }
  }

  private async deliver(pending: { report: ProgressReport; source: S }): Promise<void> {
    try {
      await this.send(pending.report, pending.source);
    } catch {
      // Progress is best effort: never fail the run over it.
    }
  }
}
