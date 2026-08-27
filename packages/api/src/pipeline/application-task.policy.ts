/**
 * Pure decisions about what happens to an application task, kept apart from the
 * Mongo plumbing so they can be tested exhaustively without a database.
 *
 * These rules decide whether a real job application is sent to a real employer a
 * second time, so they are deliberately conservative.
 */

export interface TaskFacts {
  /** Stamped immediately before the Submit click. */
  submitAttemptedAt?: Date | string | null;
  attempts: number;
  maxAttempts: number;
}

export type FailureOutcome =
  | { status: 'queued' }
  | { status: 'needs_review'; reason: string }
  | { status: 'failed' };

/**
 * What to do with a task whose worker reported (or was inferred to have)
 * failure.
 *
 * The submit stamp dominates everything else: once a submit has been attempted
 * we cannot tell from outside whether the employer received it, so the task is
 * never retried automatically no matter how many attempts remain.
 */
export function decideAfterFailure(task: TaskFacts): FailureOutcome {
  if (task.submitAttemptedAt) {
    return {
      status: 'needs_review',
      reason: 'may already have been submitted; not retried automatically',
    };
  }
  if (task.attempts < task.maxAttempts) return { status: 'queued' };
  return { status: 'failed' };
}

/**
 * What a task still marked 'running' means once its worker process is gone.
 *
 * The worker writes its own outcome when it can, so reaching here means it
 * crashed, was killed, or hung. The job document is then the only evidence of
 * what actually happened.
 */
export function decideAfterAbandonedRun(jobStatus: string | undefined): 'succeeded' | 'failed' {
  return jobStatus === 'applied' ? 'succeeded' : 'failed';
}
