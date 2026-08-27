import type { ApplicationTask } from '../types';

export type TaskView =
  | { kind: 'status'; label: string; tone: string; title: string }
  | { kind: 'retry'; label: string; tone: string; title: string }
  | { kind: 'apply' };

/**
 * How one job's Apply cell should read. The server owns this now — `optimistic`
 * only covers the moment between clicking and the task showing up in the poll.
 *
 * needs_review is the one that matters: the worker died after a submit was
 * attempted, so the employer may already have the application. It is never
 * retried automatically, and the label has to say why before anyone clicks.
 */
export function describeTask(task: ApplicationTask | undefined, optimistic: boolean): TaskView {
  if (!task) return optimistic ? { kind: 'status', label: 'Starting…', tone: 'queued', title: 'Queueing this application…' } : { kind: 'apply' };

  switch (task.status) {
    case 'queued':
      return {
        kind: 'status',
        label: task.attempts > 0 ? `Retrying (${task.attempts + 1})` : 'Queued',
        tone: 'queued',
        title: 'Waiting for a free slot. Two applications run at a time.',
      };
    case 'running':
      return { kind: 'status', label: 'Applying…', tone: 'running', title: 'A browser is filling this application now.' };
    case 'succeeded':
      return { kind: 'status', label: 'Applied', tone: 'succeeded', title: 'Application completed.' };
    case 'skipped':
      return {
        kind: 'retry',
        label: 'No form',
        tone: 'skipped',
        title: `${task.lastError || 'Nothing to apply to on this posting.'}\n\nClick to try again anyway.`,
      };
    case 'needs_review':
      return {
        kind: 'retry',
        label: 'Check manually',
        tone: 'needs-review',
        title:
          'This run stopped after Submit was clicked, so the employer may already have ' +
          'your application. It is deliberately not retried automatically.\n\n' +
          'Check the job before clicking — applying twice is worse than not retrying.',
      };
    case 'cancelled':
      return { kind: 'apply' };
    case 'failed':
    default:
      return {
        kind: 'retry',
        label: 'Failed — retry',
        tone: 'failed',
        title: `${task.lastError || 'The application did not complete.'}\n\nTried ${task.attempts} of ${task.maxAttempts} times. Click to try again.`,
      };
  }
}
