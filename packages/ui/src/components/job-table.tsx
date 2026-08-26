import { useState, useEffect } from 'react';
import type { ScoredJob } from '../types';
import { INTERVIEW_ROUNDS, ACCEPTED_OUTCOMES, roleKey } from './app';

// Shown on a Queue row when the same role is already tracked elsewhere, so an
// already-handled job is obvious without cross-checking the Applied tab.
const TRACKED_BADGE_LABELS: Record<string, string> = {
  applied: 'Applied',
  no_response: 'No response',
  declined: 'Declined',
  interviewing: 'Interviewing',
  accepted: 'Accepted',
};

type Tab = 'queue' | 'applied' | 'interviewing' | 'accepted' | 'rejected' | 'prepare';

export type SortBy =
  | 'default'        // existing behavior: new-within-24h first, then by score
  | 'posted-new'     // posted_at descending (newest first)
  | 'posted-old'     // posted_at ascending (oldest first)
  | 'scraped-new'    // scraped_at descending
  | 'scraped-old'    // scraped_at ascending
  | 'score-high'     // fit_score descending
  | 'score-low';     // fit_score ascending

interface JobTableProps {
  jobs: ScoredJob[];
  activeTab: Tab;
  selectMode?: boolean;
  sortBy?: SortBy;
  onSelectJob: (job: ScoredJob) => void;
  onDismissJob?: (job: ScoredJob) => void;
  onMarkApplied?: (job: ScoredJob) => void;
  onUpdateStatus?: (
    job: ScoredJob,
    status: string,
    interviewRound?: string,
    acceptedOutcome?: string,
  ) => void;
  onAutoApply?: (jobIds: string[]) => void;
  onCancelSelect?: () => void;
  /** roleKey -> the status this role already has elsewhere, for the Queue badge. */
  trackedStatusByRole?: Map<string, string>;
}

function formatSalary(min?: number, max?: number): string {
  if (!min && !max) return '--';
  const fmt = (n: number) => `$${Math.round(n / 1000)}k`;
  if (min && max) return `${fmt(min)} - ${fmt(max)}`;
  return min ? fmt(min) : fmt(max!);
}

function formatRelativeDate(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return '1d ago';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function scoreClass(score: number): string {
  if (score >= 7) return 'high';
  if (score >= 5) return 'mid';
  return 'low';
}

export function JobTable({ jobs, activeTab, selectMode, sortBy = 'default', onSelectJob, onDismissJob, onMarkApplied, onUpdateStatus, onAutoApply, onCancelSelect, trackedStatusByRole }: JobTableProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Rows whose bot run has been kicked off. Cleared when the job leaves the
  // Queue (status flips to applied), which is the real completion signal.
  const [applying, setApplying] = useState<Set<string>>(new Set());

  // A launched job stays "Applying…" until it leaves the Queue — the bot holds the
  // browser open for review, so the run really is still in flight. app.tsx repolls
  // every 5s, so the row vanishes once the status flips and this prunes the id.
  useEffect(() => {
    setApplying((prev) => {
      if (prev.size === 0) return prev;
      const present = new Set(jobs.map((j) => j.id));
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [jobs]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === jobs.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(jobs.map((j) => j.id)));
    }
  };

  const exitSelectMode = () => {
    setSelectedIds(new Set());
    onCancelSelect?.();
  };

  if (jobs.length === 0) {
    return (
      <div className="empty-state">
        <p>No jobs in this category</p>
      </div>
    );
  }

  const tsOrZero = (s?: string) => (s ? new Date(s).getTime() : 0);

  const sorted = [...jobs].sort((a, b) => {
    // Applied / Interviewing / Accepted sort by applied_at desc — most actionable order.
    if (activeTab === 'applied' || activeTab === 'interviewing' || activeTab === 'accepted') {
      return tsOrZero(b.applied_at) - tsOrZero(a.applied_at);
    }
    switch (sortBy) {
      case 'posted-new':
        return tsOrZero(b.posted_at) - tsOrZero(a.posted_at);
      case 'posted-old': {
        // Jobs with no posted_at go last (they're usually Indeed / sources that
        // don't expose a date; sorting them to the top of "oldest first" would
        // be misleading).
        const aT = tsOrZero(a.posted_at);
        const bT = tsOrZero(b.posted_at);
        if (aT === 0) return 1;
        if (bT === 0) return -1;
        return aT - bT;
      }
      case 'scraped-new':
        return tsOrZero(b.scraped_at) - tsOrZero(a.scraped_at);
      case 'scraped-old':
        return tsOrZero(a.scraped_at) - tsOrZero(b.scraped_at);
      case 'score-high':
        return b.fit_score - a.fit_score;
      case 'score-low':
        return a.fit_score - b.fit_score;
      case 'default':
      default: {
        // Existing behavior: jobs scraped in the last 24h first, then by score.
        const now = Date.now();
        const aNew = now - new Date(a.scraped_at).getTime() < 86400000 ? 1 : 0;
        const bNew = now - new Date(b.scraped_at).getTime() < 86400000 ? 1 : 0;
        if (bNew !== aNew) return bNew - aNew;
        return b.fit_score - a.fit_score;
      }
    }
  });

  const isNew = (scraped_at: string) => Date.now() - new Date(scraped_at).getTime() < 86400000;

  return (
    <>
    {activeTab === 'queue' && selectMode && (
      <div className="auto-apply-bar">
        <span>{selectedIds.size} job{selectedIds.size !== 1 ? 's' : ''} selected</span>
        <div className="auto-apply-actions">
          <button className="cancel-select-btn" onClick={exitSelectMode}>Cancel</button>
          <button
            className="auto-apply-btn"
            disabled={selectedIds.size === 0}
            onClick={() => { onAutoApply?.(Array.from(selectedIds)); exitSelectMode(); }}
          >
            Auto Apply ({selectedIds.size})
          </button>
        </div>
      </div>
    )}
    <table className="job-table">
      <thead>
        <tr>
          {activeTab === 'queue' && selectMode && (
            <th><input type="checkbox" checked={selectedIds.size === jobs.length && jobs.length > 0} onChange={toggleAll} /></th>
          )}
          <th>Score</th>
          <th>Company</th>
          <th>Position</th>
          <th>Salary</th>
          {activeTab !== 'rejected' && <th>Tech Stack</th>}
          <th>Platform</th>
          <th title="When this job was first scraped into the tracker">Scraped</th>
          {activeTab === 'queue' && <th>Posted</th>}
          {activeTab === 'applied' && <th>Applied</th>}
          {activeTab === 'applied' && <th>Status</th>}
          {activeTab === 'interviewing' && <th>Added</th>}
          {activeTab === 'interviewing' && <th>Round</th>}
          {activeTab === 'interviewing' && <th>Outcome</th>}
          {activeTab === 'accepted' && <th>Added</th>}
          {activeTab === 'accepted' && <th>Outcome</th>}
          {activeTab === 'accepted' && <th>Status</th>}
          {activeTab === 'rejected' && <th>Reason</th>}
          {activeTab === 'queue' && <th>Apply</th>}
          {activeTab === 'queue' && <th></th>}
        </tr>
      </thead>
      <tbody>
        {sorted.map((job) => (
          <tr key={job.id} onClick={() => onSelectJob(job)}>
            {activeTab === 'queue' && selectMode && (
              <td>
                <input
                  type="checkbox"
                  checked={selectedIds.has(job.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleSelect(job.id)}
                />
              </td>
            )}
            <td>
              <span className={`score ${scoreClass(job.fit_score)}`}>
                {job.fit_score}
              </span>
            </td>
            <td>
              {job.company}
              {isNew(job.scraped_at) && <span className="new-badge">New</span>}
            </td>
            <td>
              {job.title}
              {activeTab === 'queue' &&
                (() => {
                  // Only meaningful for a different record — a job is trivially
                  // "tracked" as itself once its own status changes.
                  const tracked = trackedStatusByRole?.get(roleKey(job));
                  return tracked && tracked !== job.status ? (
                    <span
                      className={`tracked-badge ${tracked}`}
                      title={`You already have this role tracked as "${TRACKED_BADGE_LABELS[tracked] ?? tracked}"`}
                    >
                      {TRACKED_BADGE_LABELS[tracked] ?? tracked}
                    </span>
                  ) : null;
                })()}
            </td>
            <td>
              <span className="salary">
                {formatSalary(job.salary_min, job.salary_max)}
              </span>
            </td>
            {activeTab !== 'rejected' && (
              <td>
                <div className="skills">
                  {job.matched_skills.slice(0, 4).map((skill) => (
                    <span key={skill} className="skill-tag">{skill}</span>
                  ))}
                  {job.matched_skills.length > 4 && (
                    <span className="skill-tag">+{job.matched_skills.length - 4}</span>
                  )}
                </div>
              </td>
            )}
            <td>
              <span className={`platform ${job.source}`}>{job.source}</span>
            </td>
            <td
              className="scraped-date"
              title={job.scraped_at ? new Date(job.scraped_at).toLocaleString() : 'unknown'}
            >
              {job.scraped_at ? formatRelativeDate(job.scraped_at) : '--'}
            </td>
            {activeTab === 'queue' && (
              <td className="posted-date">
                {job.posted_at ? formatRelativeDate(job.posted_at) : '--'}
              </td>
            )}
            {activeTab === 'applied' && (
              <td>
                <div className="applied-info">
                  <span className={`applied-via ${job.applied_via || 'manual'}`}>
                    {job.applied_via === 'auto' ? 'Auto' : 'Manual'}
                  </span>
                  <span className="applied-date">
                    {job.applied_at ? new Date(job.applied_at).toLocaleDateString() : '--'}
                  </span>
                </div>
              </td>
            )}
            {activeTab === 'applied' && (
              <td>
                <select
                  className="status-dropdown"
                  value={job.status}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    e.stopPropagation();
                    onUpdateStatus?.(job, e.target.value);
                  }}
                >
                  <option value="applied">Waiting</option>
                  <option value="interviewing">Interviewing</option>
                  <option value="accepted">Accepted</option>
                  <option value="declined">Declined</option>
                  <option value="no_response">No Response</option>
                </select>
              </td>
            )}
            {activeTab === 'interviewing' && (
              <td>
                <span className="applied-date">
                  {job.applied_at ? new Date(job.applied_at).toLocaleDateString() : '--'}
                </span>
              </td>
            )}
            {activeTab === 'interviewing' && (
              <td>
                <select
                  className="status-dropdown"
                  value={job.interview_round ?? INTERVIEW_ROUNDS[0]}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    e.stopPropagation();
                    onUpdateStatus?.(job, 'interviewing', e.target.value);
                  }}
                >
                  {INTERVIEW_ROUNDS.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </td>
            )}
            {activeTab === 'interviewing' && (
              <td>
                <select
                  className="status-dropdown"
                  value="interviewing"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    e.stopPropagation();
                    onUpdateStatus?.(job, e.target.value);
                  }}
                  title="Move this role out of the Interviewing tab when an outcome is reached"
                >
                  <option value="interviewing">In Progress</option>
                  <option value="accepted">Accepted</option>
                  <option value="declined">Declined</option>
                  <option value="rejected">Rejected</option>
                  <option value="no_response">Ghosted</option>
                </select>
              </td>
            )}
            {activeTab === 'accepted' && (
              <td>
                <span className="applied-date">
                  {job.applied_at ? new Date(job.applied_at).toLocaleDateString() : '--'}
                </span>
              </td>
            )}
            {activeTab === 'accepted' && (
              <td>
                <select
                  className="status-dropdown"
                  value={job.accepted_outcome ?? ACCEPTED_OUTCOMES[0]}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    e.stopPropagation();
                    onUpdateStatus?.(job, 'accepted', undefined, e.target.value);
                  }}
                >
                  {ACCEPTED_OUTCOMES.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </td>
            )}
            {activeTab === 'accepted' && (
              <td>
                <select
                  className="status-dropdown"
                  value="accepted"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    e.stopPropagation();
                    onUpdateStatus?.(job, e.target.value);
                  }}
                  title="Move this role out of the Accepted tab"
                >
                  <option value="accepted">In Accepted</option>
                  <option value="interviewing">Back to Interviewing</option>
                  <option value="declined">Declined</option>
                  <option value="rejected">Rejected</option>
                </select>
              </td>
            )}
            {activeTab === 'rejected' && (
              <td>
                <span className="reason-text" title={job.reason}>
                  {job.reason}
                </span>
              </td>
            )}
            {activeTab === 'queue' && (
              <td>
                <div className="apply-actions">
                  <button
                    className="apply-link"
                    disabled={applying.has(job.id)}
                    title={
                      'Launch the bot for this job: it opens the application, fills every ' +
                      'field it can, and stops before Submit so you can review. ' +
                      'Enable auto-submit in Settings to have it submit too.'
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      // The pipeline lets auto-apply runs start concurrently, so a
                      // double-click would spawn a second browser for the same job.
                      if (applying.has(job.id)) return;
                      setApplying((prev) => new Set(prev).add(job.id));
                      onAutoApply?.([job.id]);
                    }}
                  >
                    {applying.has(job.id) ? 'Applying…' : 'Apply'}
                  </button>
                  <button
                    className="applied-btn"
                    title="Mark as applied"
                    onClick={(e) => {
                      e.stopPropagation();
                      onMarkApplied?.(job);
                    }}
                  >
                    Applied
                  </button>
                </div>
              </td>
            )}
            {activeTab === 'queue' && (
              <td>
                <button
                  className="dismiss-btn"
                  title="Mark as expired / not available"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDismissJob?.(job);
                  }}
                >
                  &times;
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}
