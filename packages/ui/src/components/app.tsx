import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import type { ScoredJob } from '../types';
import { TabBar } from './tab-bar';
import { JobTable } from './job-table';
import { JobDetail } from './job-detail';
import { CommandPanel } from './command-panel';
import type { SortBy } from './job-table';
import { KeywordManager } from './keyword-manager';
import { ProfileEditor } from './profile-editor';
import { FormAnswers } from './form-answers';
import { CoverLettersPage, type CoverLetterJob } from './cover-letters';
import { PendingQuestion } from './pending-question';
import { PrepareReview } from './prepare-review';

type Tab = 'queue' | 'applied' | 'accepted' | 'declined' | 'rejected' | 'cover-letters' | 'prepare';
type PlatformFilter = 'all' | 'linkedin' | 'greenhouse' | 'lever' | 'indeed' | 'ashby' | 'manual';

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('queue');
  const [jobs, setJobs] = useState<ScoredJob[]>([]);
  const [coverLetterJobs, setCoverLetterJobs] = useState<CoverLetterJob[]>([]);
  const [prepareJobs, setPrepareJobs] = useState<any[]>([]);
  const [selectedJob, setSelectedJob] = useState<ScoredJob | null>(null);
  const [commandPanelOpen, setCommandPanelOpen] = useState(false);
  const [keywordManagerOpen, setKeywordManagerOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [formAnswersOpen, setFormAnswersOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('all');
  const [autoApplyMode, setAutoApplyMode] = useState(false);
  const [scoreFilter, setScoreFilter] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [newOnlyFilter, setNewOnlyFilter] = useState(false);
  const [addJobOpen, setAddJobOpen] = useState(false);
  const [newJob, setNewJob] = useState({ title: '', company: '', url: '' });
  const [sortBy, setSortBy] = useState<SortBy>('default');
  // Global "allow bot to submit applications" toggle, persisted in UserModel.settings.
  const [allowAutoSubmit, setAllowAutoSubmit] = useState<boolean>(false);

  // Load settings once on mount.
  useEffect(() => {
    axios.get<{ allowAutoSubmit: boolean }>('/api/settings')
      .then((r) => setAllowAutoSubmit(r.data?.allowAutoSubmit === true))
      .catch(() => { /* leave at default false */ });
  }, []);

  const toggleAllowAutoSubmit = async () => {
    const next = !allowAutoSubmit;
    setAllowAutoSubmit(next);
    try {
      await axios.put('/api/settings', { allowAutoSubmit: next });
    } catch {
      // revert on failure
      setAllowAutoSubmit(!next);
    }
  };

  const fetchJobs = useCallback(async () => {
    try {
      const { data } = await axios.get<ScoredJob[]>('/api/jobs');
      setJobs(data);
    } catch (err) {
      console.error('Failed to fetch jobs:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCoverLetters = useCallback(async () => {
    try {
      const { data } = await axios.get<CoverLetterJob[]>('/api/jobs/cover-letters');
      setCoverLetterJobs(data);
    } catch {
      // ignore
    }
  }, []);

  const fetchPrepareJobs = useCallback(async () => {
    try {
      const { data } = await axios.get('/api/application-fields');
      setPrepareJobs(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { fetchJobs(); fetchCoverLetters(); fetchPrepareJobs(); }, [fetchJobs, fetchCoverLetters, fetchPrepareJobs]);

  // Refresh cover letters / prepare when switching to those tabs
  useEffect(() => {
    if (activeTab === 'cover-letters') fetchCoverLetters();
    if (activeTab === 'prepare') fetchPrepareJobs();
  }, [activeTab, fetchCoverLetters, fetchPrepareJobs]);

  const handleClosePanel = useCallback(() => {
    setCommandPanelOpen(false);
    fetchJobs();
  }, [fetchJobs]);

  const handleCommandComplete = useCallback(async () => {
    await fetchJobs();
    await fetchCoverLetters();
  }, [fetchJobs, fetchCoverLetters]);

  // Poll for new jobs every 5 seconds — keeps UI in sync with real-time scoring
  useEffect(() => {
    const interval = setInterval(fetchJobs, 5000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  const handleDismissJob = useCallback(async (job: ScoredJob) => {
    try {
      await axios.patch(`/api/jobs/${job.id}/status`, {
        status: 'rejected',
        reason: 'Posting no longer available',
      });
      setJobs((prev) => prev.map((j) => j.id === job.id ? { ...j, status: 'rejected' as const, reason: 'Posting no longer available' } : j));
    } catch (err) {
      console.error('Failed to dismiss job:', err);
    }
  }, []);

  const handleMarkApplied = useCallback(async (job: ScoredJob) => {
    try {
      await axios.patch(`/api/jobs/${job.id}/status`, { status: 'applied' });
      setJobs((prev) => prev.map((j) => j.id === job.id ? { ...j, status: 'applied' as const, applied_at: new Date().toISOString() } : j));
    } catch (err) {
      console.error('Failed to mark applied:', err);
    }
  }, []);

  const handleUpdateStatus = useCallback(async (job: ScoredJob, status: string) => {
    try {
      await axios.patch(`/api/jobs/${job.id}/status`, { status });
      setJobs((prev) => prev.map((j) => j.id === job.id ? { ...j, status: status as any } : j));
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  }, []);

  const handleAutoApply = useCallback(async (jobIds: string[]) => {
    try {
      await axios.post('/api/pipeline/auto-apply', { jobIds });
    } catch (err: any) {
      const msg = err.response?.data?.message || 'Failed to start auto-apply';
      alert(msg);
      console.error('Failed to start auto-apply:', msg);
    }
  }, []);

  const handleGenerateCoverLetters = useCallback(async (jobIds: string[]) => {
    try {
      await axios.post('/api/pipeline/generate-cover-letters', { jobIds });
    } catch (err) {
      console.error('Failed to start cover letter generation:', err);
    }
  }, []);

  // Split by status FIRST — these arrays drive the tab badge counts and must
  // reflect totals, not the currently-applied filter (otherwise filtering on
  // Queue makes the Applied/Accepted badges shrink too).
  const queue = jobs.filter((j) => j.status === 'to_apply');
  const applied = jobs.filter((j) => ['applied', 'interviewing', 'no_response'].includes(j.status));
  const accepted = jobs.filter((j) => j.status === 'accepted');
  const declined = jobs.filter((j) => j.status === 'declined');
  const rejected = jobs.filter((j) => j.status === 'rejected');

  const activeTabJobs = activeTab === 'queue' ? queue
    : activeTab === 'applied' ? applied
    : activeTab === 'accepted' ? accepted
    : activeTab === 'declined' ? declined
    : rejected;

  // Filters apply ONLY to the currently-visible tab. State persists across tab
  // switches (so a search query carries over if you flip to a different tab to
  // look up the same company), but other tabs' counts are unaffected.
  const byPlatform = platformFilter === 'all' ? activeTabJobs : activeTabJobs.filter((j) => j.source === platformFilter);
  const byScore = scoreFilter > 0 ? byPlatform.filter((j) => j.fit_score === scoreFilter) : byPlatform;
  const byNew = newOnlyFilter ? byScore.filter((j) => Date.now() - new Date(j.scraped_at).getTime() < 86400000) : byScore;
  const tabJobs = searchQuery
    ? byNew.filter((j) =>
        j.company.toLowerCase().includes(searchQuery.toLowerCase()) ||
        j.title.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : byNew;

  if (loading) {
    return (
      <div className="container">
        <div className="app-header"><h1>JobPilot</h1></div>
        <div className="empty-state"><p>Loading...</p></div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="app-header">
        <h1>JobPilot</h1>
        <label
          className={`auto-submit-toggle ${allowAutoSubmit ? 'on' : 'off'}`}
          title={allowAutoSubmit
            ? 'Bot is ALLOWED to click Submit on every auto-apply. Click to disable (dry-run).'
            : 'Bot will fill forms but STOP before Submit. Click to enable real submissions.'}
        >
          <input type="checkbox" checked={allowAutoSubmit} onChange={toggleAllowAutoSubmit} />
          <span className="auto-submit-dot" />
          <span className="auto-submit-label">Auto-submit: {allowAutoSubmit ? 'ON' : 'OFF (dry-run)'}</span>
        </label>
        <div className="hamburger-wrapper">
          <button className="hamburger-btn" onClick={() => setMenuOpen(!menuOpen)}>
            <span /><span /><span />
          </button>
          {menuOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="hamburger-menu">
                <button onClick={() => { setProfileOpen(true); setMenuOpen(false); }}>
                  Candidate Profile
                </button>
                <button onClick={() => { setKeywordManagerOpen(true); setMenuOpen(false); }}>
                  Keywords
                </button>
                <button onClick={() => { setFormAnswersOpen(true); setMenuOpen(false); }}>
                  Saved Rules
                </button>
                <button onClick={() => { setCommandPanelOpen(true); setMenuOpen(false); }}>
                  Pipeline
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <TabBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        counts={{ queue: queue.length, applied: applied.length, accepted: accepted.length, declined: declined.length, rejected: rejected.length, coverLetters: coverLetterJobs.length, prepare: prepareJobs.filter((p: any) => p.status !== 'applied').length }}
        onOpenCommands={() => setCommandPanelOpen(true)}
        onOpenKeywords={() => setKeywordManagerOpen(true)}
      />

      {activeTab !== 'cover-letters' && activeTab !== 'prepare' && (
        <>
          <div className="filter-row">
            <div className="search-filter">
              <input
                className="search-input"
                placeholder="Search company or title..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button className="search-clear" onClick={() => setSearchQuery('')}>&times;</button>
              )}
            </div>
            <div className="platform-filter">
              {(['all', 'linkedin', 'greenhouse', 'ashby', 'lever', 'indeed'] as PlatformFilter[]).map((p) => (
                <button
                  key={p}
                  className={`filter-btn ${platformFilter === p ? 'active' : ''}`}
                  onClick={() => setPlatformFilter(p)}
                >
                  {p === 'all' ? 'All' : p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
            <button
              className={`filter-btn ${newOnlyFilter ? 'active' : ''}`}
              onClick={() => setNewOnlyFilter(!newOnlyFilter)}
              style={{ fontWeight: newOnlyFilter ? 600 : 400 }}
            >
              New (24h)
            </button>
            <div className="score-filter">
              <span className="score-filter-label">Score:</span>
              {[0, 5, 6, 7, 8, 9].map((s) => (
                <button
                  key={s}
                  className={`filter-btn ${scoreFilter === s ? 'active' : ''}`}
                  onClick={() => setScoreFilter(s)}
                >
                  {s === 0 ? 'All' : s}
                </button>
              ))}
            </div>
            <div className="sort-filter">
              <span className="score-filter-label">Sort:</span>
              <select
                className="sort-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
                title="How to order jobs in the table"
              >
                <option value="default">Default (new, then score)</option>
                <option value="posted-new">Posted: newest first</option>
                <option value="posted-old">Posted: oldest first</option>
                <option value="scraped-new">Scraped: newest first</option>
                <option value="scraped-old">Scraped: oldest first</option>
                <option value="score-high">Score: high to low</option>
                <option value="score-low">Score: low to high</option>
              </select>
            </div>
            {activeTab === 'queue' && !autoApplyMode && (
              <button className="select-to-apply-btn" onClick={() => setAutoApplyMode(true)}>
                Select to Auto Apply
              </button>
            )}
            {activeTab === 'applied' && (
              <button className="select-to-apply-btn" onClick={() => setAddJobOpen(true)}>
                + Add Job
              </button>
            )}
          </div>
          <JobTable jobs={tabJobs} activeTab={activeTab} selectMode={autoApplyMode} sortBy={sortBy} onSelectJob={setSelectedJob} onDismissJob={handleDismissJob} onMarkApplied={handleMarkApplied} onUpdateStatus={handleUpdateStatus} onAutoApply={(ids) => { handleAutoApply(ids); setAutoApplyMode(false); }} onGenerateCoverLetters={(ids) => { handleGenerateCoverLetters(ids); setAutoApplyMode(false); }} onCancelSelect={() => setAutoApplyMode(false)} />
        </>
      )}

      {activeTab === 'prepare' && (
        <PrepareReview jobs={prepareJobs} onRefresh={fetchPrepareJobs} onAutoApply={handleAutoApply} onDismissJob={async (jobId) => {
          try {
            await axios.patch(`/api/jobs/${jobId}/status`, { status: 'rejected', reason: 'Removed from prepare list' });
            fetchJobs();
          } catch { /* ignore */ }
        }} />
      )}

      {activeTab === 'cover-letters' && (
        <CoverLettersPage jobs={coverLetterJobs} />
      )}

      {selectedJob && (
        <JobDetail
          job={selectedJob}
          onClose={() => setSelectedJob(null)}
          onJobUpdate={(updated) => {
            setSelectedJob(updated);
            setJobs((prev) => prev.map((j) => j.id === updated.id ? updated : j));
          }}
        />
      )}
      <CommandPanel
        isOpen={commandPanelOpen}
        onClose={handleClosePanel}
        onComplete={handleCommandComplete}
      />
      <KeywordManager
        isOpen={keywordManagerOpen}
        onClose={() => setKeywordManagerOpen(false)}
      />
      <ProfileEditor
        isOpen={profileOpen}
        onClose={() => setProfileOpen(false)}
      />
      <FormAnswers
        isOpen={formAnswersOpen}
        onClose={() => setFormAnswersOpen(false)}
      />
      <PendingQuestion />
      {addJobOpen && (
        <div className="modal-overlay" onClick={() => setAddJobOpen(false)}>
          <div className="add-job-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add External Application</h3>
            <p className="add-job-hint">Track a job you applied to outside this app.</p>
            <div className="add-job-form">
              <input
                placeholder="Job Title *"
                value={newJob.title}
                onChange={(e) => setNewJob({ ...newJob, title: e.target.value })}
                autoFocus
              />
              <input
                placeholder="Company *"
                value={newJob.company}
                onChange={(e) => setNewJob({ ...newJob, company: e.target.value })}
              />
              <input
                placeholder="Job URL (optional)"
                value={newJob.url}
                onChange={(e) => setNewJob({ ...newJob, url: e.target.value })}
              />
              <div className="add-job-actions">
                <button className="prepare-cancel-btn" onClick={() => { setAddJobOpen(false); setNewJob({ title: '', company: '', url: '' }); }}>
                  Cancel
                </button>
                <button
                  className="auto-apply-btn"
                  disabled={!newJob.title.trim() || !newJob.company.trim()}
                  onClick={async () => {
                    try {
                      await axios.post('/api/jobs/manual', newJob);
                      setAddJobOpen(false);
                      setNewJob({ title: '', company: '', url: '' });
                      fetchJobs();
                    } catch (err) {
                      console.error('Failed to add job:', err);
                    }
                  }}
                >
                  Add to Applied
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
