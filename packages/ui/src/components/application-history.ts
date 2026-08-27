import type { ApplicationTask, ApplicationTaskStatus } from '../types';

export type TaskFilter = 'attention' | 'active' | 'done' | 'all';

/** Failed in a way a person still has to decide about. */
const ATTENTION: ApplicationTaskStatus[] = ['needs_review', 'failed', 'skipped'];
/** Still going, or waiting for a worker slot. */
const ACTIVE: ApplicationTaskStatus[] = ['queued', 'running'];

export function matchesFilter(task: ApplicationTask, filter: TaskFilter): boolean {
  switch (filter) {
    case 'attention':
      return ATTENTION.includes(task.status);
    case 'active':
      return ACTIVE.includes(task.status);
    case 'done':
      return task.status === 'succeeded' || task.status === 'cancelled';
    case 'all':
    default:
      return true;
  }
}

export interface TaskCounts {
  attention: number;
  active: number;
  done: number;
  all: number;
  /** Broken out because it is the only status that may mean a duplicate application. */
  needsReview: number;
}

export function countTasks(tasks: ApplicationTask[]): TaskCounts {
  return {
    attention: tasks.filter((t) => matchesFilter(t, 'attention')).length,
    active: tasks.filter((t) => matchesFilter(t, 'active')).length,
    done: tasks.filter((t) => matchesFilter(t, 'done')).length,
    all: tasks.length,
    needsReview: tasks.filter((t) => t.status === 'needs_review').length,
  };
}

/**
 * Compact relative time. Application runs are minutes-to-hours old and the
 * column is narrow, so absolute timestamps waste the space.
 */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const secs = Math.round((now - then) / 1000);
  if (secs < 0) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
