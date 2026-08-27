import { describe, it, expect } from 'vitest';
import { describeTask } from '../components/task-view';
import type { ApplicationTask } from '../types';

const task = (over: Partial<ApplicationTask> = {}): ApplicationTask => ({
  _id: 't1',
  externalJobId: 'j1',
  status: 'queued',
  attempts: 0,
  maxAttempts: 2,
  createdAt: '2026-08-26T10:00:00.000Z',
  ...over,
});

describe('describeTask', () => {
  it('offers Apply when the job has never been queued', () => {
    expect(describeTask(undefined, false)).toEqual({ kind: 'apply' });
  });

  it('bridges the gap between clicking and the task appearing', () => {
    const v = describeTask(undefined, true);
    expect(v.kind).toBe('status');
  });

  it('shows queued and running as non-clickable status', () => {
    expect(describeTask(task({ status: 'queued' }), false).kind).toBe('status');
    expect(describeTask(task({ status: 'running' }), false).kind).toBe('status');
  });

  it('says which attempt a requeued task is on', () => {
    const v = describeTask(task({ status: 'queued', attempts: 1 }), false);
    expect(v.kind === 'status' && v.label).toBe('Retrying (2)');
  });

  it('offers a retry on failure, with the reason in the tooltip', () => {
    const v = describeTask(task({ status: 'failed', lastError: 'Timed out loading form' }), false);
    expect(v.kind).toBe('retry');
    expect(v.kind === 'retry' && v.title).toContain('Timed out loading form');
  });

  // The whole point of the needs_review state: the application may already have
  // reached the employer, so the label must not invite a casual retry.
  it('warns rather than invites when a submit may already have happened', () => {
    const v = describeTask(task({ status: 'needs_review', submitAttemptedAt: '2026-08-26T10:05:00.000Z' }), false);
    expect(v.kind).toBe('retry');
    expect(v.kind === 'retry' && v.label).toBe('Check manually');
    expect(v.kind === 'retry' && v.label.toLowerCase()).not.toContain('retry');
    expect(v.kind === 'retry' && v.title).toMatch(/may already have/i);
    expect(v.kind === 'retry' && v.tone).toBe('needs-review');
  });

  it('never labels needs_review the same as an ordinary failure', () => {
    const failed = describeTask(task({ status: 'failed' }), false);
    const review = describeTask(task({ status: 'needs_review' }), false);
    expect(failed).not.toEqual(review);
    expect(failed.kind === 'retry' && review.kind === 'retry' && failed.tone).not.toBe(
      review.kind === 'retry' ? review.tone : '',
    );
  });

  it('reports a completed application', () => {
    const v = describeTask(task({ status: 'succeeded' }), false);
    expect(v.kind === 'status' && v.label).toBe('Applied');
  });

  it('lets a skipped posting be tried again explicitly', () => {
    const v = describeTask(task({ status: 'skipped', lastError: 'No application form' }), false);
    expect(v.kind).toBe('retry');
    expect(v.kind === 'retry' && v.title).toContain('No application form');
  });

  it('returns to a plain Apply button after a cancellation', () => {
    // Stop cancels queued work; the row should simply be actionable again.
    expect(describeTask(task({ status: 'cancelled' }), false)).toEqual({ kind: 'apply' });
  });

  it('ignores the optimistic flag once real state exists', () => {
    const v = describeTask(task({ status: 'failed' }), true);
    expect(v.kind).toBe('retry');
  });
});
