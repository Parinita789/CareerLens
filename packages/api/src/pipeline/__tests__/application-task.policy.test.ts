import { describe, it, expect } from 'vitest';
import { decideAfterFailure, decideAfterAbandonedRun } from '../application-task.policy';

// These rules decide whether a real application is sent to a real employer a
// second time. The submit stamp must dominate every other consideration.
describe('decideAfterFailure', () => {
  it('retries a failure that never reached the submit button', () => {
    expect(decideAfterFailure({ attempts: 1, maxAttempts: 2 })).toEqual({ status: 'queued' });
  });

  it('stops retrying once attempts are exhausted', () => {
    expect(decideAfterFailure({ attempts: 2, maxAttempts: 2 })).toEqual({ status: 'failed' });
    expect(decideAfterFailure({ attempts: 5, maxAttempts: 2 })).toEqual({ status: 'failed' });
  });

  it('never retries a task that may already have been submitted', () => {
    // The whole point: the process died after clicking Submit, so the employer
    // may already have the application. Retrying would apply twice.
    const got = decideAfterFailure({ submitAttemptedAt: new Date(), attempts: 1, maxAttempts: 2 });
    expect(got.status).toBe('needs_review');
  });

  it('keeps that rule even with every attempt still unused', () => {
    // Attempts remaining must not tempt it into a retry.
    expect(decideAfterFailure({ submitAttemptedAt: new Date(), attempts: 0, maxAttempts: 10 }).status).toBe(
      'needs_review',
    );
  });

  it('treats a stamp deserialised from Mongo as a string the same way', () => {
    expect(
      decideAfterFailure({ submitAttemptedAt: '2026-08-26T10:00:00.000Z', attempts: 0, maxAttempts: 3 }).status,
    ).toBe('needs_review');
  });

  it('ignores an absent or null stamp', () => {
    expect(decideAfterFailure({ submitAttemptedAt: null, attempts: 0, maxAttempts: 3 })).toEqual({
      status: 'queued',
    });
    expect(decideAfterFailure({ submitAttemptedAt: undefined, attempts: 0, maxAttempts: 3 })).toEqual({
      status: 'queued',
    });
  });
});

describe('decideAfterAbandonedRun', () => {
  it('counts the application as succeeded when the job came out applied', () => {
    // The worker was killed before it could record anything, but the job itself
    // is the evidence that the application went through.
    expect(decideAfterAbandonedRun('applied')).toBe('succeeded');
  });

  it('counts anything else as failed', () => {
    expect(decideAfterAbandonedRun('to_apply')).toBe('failed');
    expect(decideAfterAbandonedRun(undefined)).toBe('failed');
    expect(decideAfterAbandonedRun('rejected')).toBe('failed');
  });
});
