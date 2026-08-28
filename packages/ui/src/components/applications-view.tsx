import { useState } from 'react';
import type { ApplicationTask } from '../types';
import { describeTask } from './task-view';
import { countTasks, defaultFilter, matchesFilter, relativeTime, type TaskFilter } from './application-history';

interface ApplicationsViewProps {
  tasks: ApplicationTask[];
  onRetryTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
}

const FILTERS: { key: TaskFilter; label: string }[] = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'active', label: 'In flight' },
  { key: 'done', label: 'Completed' },
  { key: 'all', label: 'All' },
];

/**
 * History for every application the bot has run, including jobs that have since
 * left the Queue. The badges in the job table only cover rows still sitting in
 * Queue, so anything that succeeded — or failed and was then applied to by hand
 * — became invisible the moment its job moved tabs.
 */
export function ApplicationsView({ tasks, onRetryTask, onCancelTask }: ApplicationsViewProps) {
  const counts = countTasks(tasks);
  // Null until the user picks one. Computing a default in useState froze it at
  // mount, when the first poll may not have landed and every count was zero —
  // so the "open on what needs a decision" behaviour silently never happened.
  // Deriving it keeps that promise without ever overriding an explicit choice.
  const [chosen, setChosen] = useState<TaskFilter | null>(null);
  const filter = chosen ?? defaultFilter(counts);
  const shown = tasks.filter((t) => matchesFilter(t, filter));

  return (
    <div className="applications-view">
      {counts.needsReview > 0 && (
        <div className="review-warning">
          <strong>
            {counts.needsReview} application{counts.needsReview === 1 ? '' : 's'} stopped after Submit was
            clicked.
          </strong>{' '}
          These may already have reached the employer, so they are never retried automatically. Check the
          company&rsquo;s site before retrying — applying twice is worse than not retrying.
        </div>
      )}

      <div className="applications-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`filter-btn ${filter === f.key ? 'active' : ''}`}
            onClick={() => setChosen(f.key)}
          >
            {f.label} <span className="count">({counts[f.key]})</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="applications-empty">
          {tasks.length === 0
            ? 'No applications yet. Hit Apply on a job in the Queue and it will show up here.'
            : 'Nothing under this filter.'}
        </div>
      ) : (
        <table className="job-table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Status</th>
              <th>Tries</th>
              <th>Detail</th>
              <th>Started</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((task) => {
              const view = describeTask(task, false);
              const label = view.kind === 'apply' ? task.status : view.label;
              const tone = view.kind === 'apply' ? 'skipped' : view.tone;
              return (
                <tr key={task._id}>
                  <td>
                    <div className="job-title">{task.title || task.externalJobId}</div>
                    {task.company && <div className="job-company">{task.company}</div>}
                  </td>
                  <td>
                    <span className={`task-badge ${tone}`} title={view.kind === 'apply' ? '' : view.title}>
                      {label}
                    </span>
                  </td>
                  <td>
                    {task.attempts}/{task.maxAttempts}
                  </td>
                  <td className="task-detail" title={task.lastError || ''}>
                    {task.lastError || '—'}
                  </td>
                  <td>{relativeTime(task.createdAt)}</td>
                  <td>
                    {task.status === 'queued' ? (
                      <button className="apply-link" onClick={() => onCancelTask(task._id)}>
                        Cancel
                      </button>
                    ) : task.status === 'running' ? (
                      <span className="task-detail">—</span>
                    ) : task.status === 'succeeded' ? (
                      // No retry: this one went through, and re-running it would
                      // send the employer a second application.
                      <span className="task-detail">—</span>
                    ) : (
                      <button
                        className="apply-link"
                        title={
                          task.status === 'needs_review'
                            ? 'This may already have been submitted. Check the employer first.'
                            : 'Queue this application again'
                        }
                        onClick={() => onRetryTask(task._id)}
                      >
                        {task.status === 'needs_review' ? 'Retry anyway' : 'Retry'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
