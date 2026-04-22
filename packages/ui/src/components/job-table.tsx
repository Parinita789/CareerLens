import { useState } from 'react';
import type { ScoredJob } from '../types';

type Tab = 'queue' | 'applied' | 'accepted' | 'declined' | 'rejected' | 'prepare';

interface JobTableProps {
  jobs: ScoredJob[];
  activeTab: Tab;
  selectMode?: boolean;
  onSelectJob: (job: ScoredJob) => void;
  onDismissJob?: (job: ScoredJob) => void;
  onMarkApplied?: (job: ScoredJob) => void;
  onUpdateStatus?: (job: ScoredJob, status: string) => void;
  onAutoApply?: (jobIds: string[]) => void;
  onGenerateCoverLetters?: (jobIds: string[]) => void;
  onCancelSelect?: () => void;
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

export function JobTable({ jobs, activeTab, selectMode, onSelectJob, onDismissJob, onMarkApplied, onUpdateStatus, onAutoApply, onGenerateCoverLetters, onCancelSelect }: JobTableProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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

  const sorted = [...jobs].sort((a, b) => {
    if (activeTab === 'applied') {
      // Applied tab: most recently applied first
      const aTime = a.applied_at ? new Date(a.applied_at).getTime() : 0;
      const bTime = b.applied_at ? new Date(b.applied_at).getTime() : 0;
      return bTime - aTime;
    }
    // Queue/Rejected: new jobs first (scraped within last 24h), then by score
    const now = Date.now();
    const aNew = now - new Date(a.scraped_at).getTime() < 86400000 ? 1 : 0;
    const bNew = now - new Date(b.scraped_at).getTime() < 86400000 ? 1 : 0;
    if (bNew !== aNew) return bNew - aNew;
    return b.fit_score - a.fit_score;
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
            className="generate-cl-btn"
            disabled={selectedIds.size === 0}
            onClick={() => { onGenerateCoverLetters?.(Array.from(selectedIds)); exitSelectMode(); }}
          >
            Generate Cover Letters ({selectedIds.size})
          </button>
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
            <td>{job.title}</td>
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
                  <a
                    className="apply-link"
                    href={job.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Apply
                  </a>
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
