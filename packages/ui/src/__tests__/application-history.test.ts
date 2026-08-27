import { describe, it, expect } from 'vitest';
import { matchesFilter, countTasks, relativeTime } from '../components/application-history';
import type { ApplicationTask, ApplicationTaskStatus } from '../types';

const t = (status: ApplicationTaskStatus, over: Partial<ApplicationTask> = {}): ApplicationTask => ({
  _id: status, externalJobId: 'j', status, attempts: 1, maxAttempts: 2,
  createdAt: '2026-08-27T10:00:00.000Z', ...over,
});

describe('matchesFilter', () => {
  it('treats anything a person must decide about as needing attention', () => {
    for (const s of ['needs_review', 'failed', 'skipped'] as ApplicationTaskStatus[]) {
      expect(matchesFilter(t(s), 'attention')).toBe(true);
    }
  });

  it('does not call finished or in-flight work attention', () => {
    for (const s of ['succeeded', 'cancelled', 'queued', 'running'] as ApplicationTaskStatus[]) {
      expect(matchesFilter(t(s), 'attention')).toBe(false);
    }
  });

  it('counts queued and running as active', () => {
    expect(matchesFilter(t('queued'), 'active')).toBe(true);
    expect(matchesFilter(t('running'), 'active')).toBe(true);
    expect(matchesFilter(t('failed'), 'active')).toBe(false);
  });

  it('puts every task in "all"', () => {
    const all: ApplicationTaskStatus[] = ['queued', 'running', 'succeeded', 'failed', 'skipped', 'needs_review', 'cancelled'];
    for (const s of all) expect(matchesFilter(t(s), 'all')).toBe(true);
  });

  it('assigns every status to at least one filter, so nothing is unreachable', () => {
    const all: ApplicationTaskStatus[] = ['queued', 'running', 'succeeded', 'failed', 'skipped', 'needs_review', 'cancelled'];
    for (const s of all) {
      const reachable = (['attention', 'active', 'done'] as const).some((f) => matchesFilter(t(s), f));
      expect(reachable, `${s} appears under no filter`).toBe(true);
    }
  });
});

describe('countTasks', () => {
  it('breaks needs_review out from the rest of attention', () => {
    const c = countTasks([t('needs_review'), t('failed'), t('succeeded'), t('running')]);
    expect(c).toEqual({ attention: 2, active: 1, done: 1, all: 4, needsReview: 1 });
  });

  it('handles an empty queue', () => {
    expect(countTasks([])).toEqual({ attention: 0, active: 0, done: 0, all: 0, needsReview: 0 });
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-08-27T12:00:00.000Z').getTime();
  it('formats each magnitude', () => {
    expect(relativeTime('2026-08-27T11:59:30.000Z', now)).toBe('30s ago');
    expect(relativeTime('2026-08-27T11:30:00.000Z', now)).toBe('30m ago');
    expect(relativeTime('2026-08-27T09:00:00.000Z', now)).toBe('3h ago');
    expect(relativeTime('2026-08-25T12:00:00.000Z', now)).toBe('2d ago');
  });
  it('survives missing or unparseable input rather than rendering NaN', () => {
    expect(relativeTime(undefined, now)).toBe('—');
    expect(relativeTime('not a date', now)).toBe('—');
  });
  it('does not show negative ages from small clock skew', () => {
    expect(relativeTime('2026-08-27T12:00:05.000Z', now)).toBe('just now');
  });
});
