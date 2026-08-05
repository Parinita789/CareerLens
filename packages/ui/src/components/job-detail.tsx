import React, { useState } from 'react';
import axios from 'axios';
import DOMPurify from 'dompurify';
import type { ScoredJob } from '../types';

function decodeHtml(html: string): string {
  const txt = document.createElement('textarea');
  txt.innerHTML = html;
  return txt.value;
}

function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(decodeHtml(html), {
    ALLOWED_TAGS: ['p', 'div', 'span', 'br', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tr', 'td', 'th', 'thead', 'tbody'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  });
}

interface JobDetailProps {
  job: ScoredJob;
  onClose: () => void;
  onJobUpdate: (updated: ScoredJob) => void;
}

export function JobDetail({ job, onClose, onJobUpdate }: JobDetailProps) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const handleGenerateCoverLetter = async () => {
    setGenerating(true);
    setError(null);
    try {
      const { data } = await axios.post<{ cover_letter: string; cover_letter_raw?: string }>(`/api/jobs/${job.id}/cover-letter`);
      setShowRaw(false);
      onJobUpdate({ ...job, cover_letter: data.cover_letter, cover_letter_raw: data.cover_letter_raw });
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to generate cover letter');
    } finally {
      setGenerating(false);
    }
  };

  const hasRawVersion = !!job.cover_letter_raw && job.cover_letter_raw !== job.cover_letter;
  const displayedLetter = showRaw && hasRawVersion ? job.cover_letter_raw! : job.cover_letter;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>{job.title}</h2>
            <div className="company">{job.company}</div>
          </div>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-meta">
          <div className="modal-meta-item">
            Score: <span style={{ color: job.fit_score >= 7 ? 'var(--green)' : job.fit_score >= 5 ? 'var(--yellow)' : 'var(--red)' }}>{job.fit_score}/10</span>
          </div>
          <div className="modal-meta-item">
            Platform: <span><span className={`platform ${job.source}`}>{job.source}</span></span>
          </div>
          <div className="modal-meta-item">
            Location: <span>{job.location || 'Remote'}</span>
          </div>
          {(job.salary_min || job.salary_max) && (
            <div className="modal-meta-item">
              Salary: <span style={{ color: 'var(--green)' }}>
                {job.salary_min && job.salary_max
                  ? `$${Math.round(job.salary_min / 1000)}k - $${Math.round(job.salary_max / 1000)}k`
                  : job.salary_min ? `$${Math.round(job.salary_min / 1000)}k+` : `Up to $${Math.round(job.salary_max! / 1000)}k`}
              </span>
            </div>
          )}
          {job.applied_at && (
            <div className="modal-meta-item">
              Applied: <span>{new Date(job.applied_at).toLocaleDateString()}</span>
            </div>
          )}
        </div>

        {job.matched_skills.length > 0 && (
          <div className="modal-section">
            <h3>Matched Skills</h3>
            <div className="skills">
              {job.matched_skills.map((s) => (
                <span key={s} className="skill-tag">{s}</span>
              ))}
            </div>
          </div>
        )}

        {job.missing_skills.length > 0 && (
          <div className="modal-section">
            <h3>Missing Skills</h3>
            <div className="skills">
              {job.missing_skills.map((s) => (
                <span key={s} className="skill-tag" style={{ background: 'var(--red-dim)', color: 'var(--red)' }}>{s}</span>
              ))}
            </div>
          </div>
        )}

        <div className="modal-section">
          <h3>Scoring Reason</h3>
          <p>{job.reason}</p>
        </div>

        {job.status !== 'rejected' && (
        <div className="modal-section">
          <h3>Cover Letter</h3>
          {job.cover_letter ? (
            <div className="cover-letter-block">
              {hasRawVersion && (
                <div className="letter-version-toggle">
                  <button
                    className={`version-btn${!showRaw ? ' active' : ''}`}
                    onClick={() => setShowRaw(false)}
                  >
                    Final
                  </button>
                  <button
                    className={`version-btn${showRaw ? ' active' : ''}`}
                    onClick={() => setShowRaw(true)}
                  >
                    Raw draft
                  </button>
                </div>
              )}
              <pre>{displayedLetter}</pre>
              <button
                className="copy-icon-btn"
                title={copied ? 'Copied!' : 'Copy to clipboard'}
                onClick={() => { navigator.clipboard.writeText(displayedLetter!); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              >
                {copied ? '✓' : '⎘'}
              </button>
            </div>
          ) : (
            <div className="cover-letter-empty">
              <p>No cover letter generated yet.</p>
              <button
                className="generate-btn"
                onClick={handleGenerateCoverLetter}
                disabled={generating}
              >
                {generating ? 'Generating...' : 'Generate Cover Letter'}
              </button>
              {error && <p className="generate-error">{error}</p>}
            </div>
          )}
          {job.cover_letter && (
            <button
              className="generate-btn regenerate"
              onClick={handleGenerateCoverLetter}
              disabled={generating}
              style={{ marginTop: '10px' }}
            >
              {generating ? 'Regenerating...' : 'Regenerate'}
            </button>
          )}
        </div>
        )}

        <div className="modal-section">
          <h3>Job Description</h3>
          {job.description.includes('&lt;') || job.description.includes('<p') || job.description.includes('<div') ? (
            <div
              className="job-description-html"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(job.description) }}
            />
          ) : (
            <pre>{job.description}</pre>
          )}
        </div>

        <div style={{ marginTop: '20px' }}>
          <a
            className="apply-link"
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: '14px' }}
          >
            Open Job Posting
          </a>
        </div>
      </div>
    </div>
  );
}
