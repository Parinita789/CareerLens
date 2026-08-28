import { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import type { ScoredJob, ApplicationTask } from '../types';
import { TabBar } from './tab-bar';
import { ApplicationsView } from './applications-view';
import { countTasks } from './application-history';
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

// Owned by TabBar, which renders them. Kept as one union so adding a tab can't
// leave a second copy behind that silently rejects it.
import type { Tab } from './tab-bar';
type PlatformFilter = 'all' | 'linkedin' | 'greenhouse' | 'lever' | 'indeed' | 'ashby' | 'manual';

export const INTERVIEW_ROUNDS = [
  'Recruiter Screen',
  'Hiring Manager',
  'Coding (Live)',
  'Coding (Take-home)',
  'System Design',
  'Behavioral',
  'Onsite / Final',
  'Offer',
  'Other',
] as const;

// Statuses that mean "this application exists" — as opposed to 'to_apply' (not
// applied yet) or 'rejected' (mostly the scorer's verdict, never an application).
const TRACKED_STATUSES = ['applied', 'no_response', 'declined', 'interviewing', 'accepted'];

// Identity for "the same role", used to reconcile records created by different
// paths (scraper vs. manual add) that share no id or URL.
export const roleKey = (j: { company?: string; title?: string }) =>
  `${String(j.company ?? '').trim().toLowerCase()}|||${String(j.title ?? '').trim().toLowerCase()}`;

// Outcomes for the Accepted tab — "accepted" here means the *application* was
// accepted (company moved you forward); these track what happened next.
export const ACCEPTED_OUTCOMES = [
  'Pending',
  'Offer Received',
  'Offer Accepted',
  'Offer Declined',
  'Withdrew',
  'Position Closed',
  'Ghosted',
] as const;

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
  const [applicationTasks, setApplicationTasks] = useState<ApplicationTask[]>([]);
  const [scoreFilter, setScoreFilter] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [newOnlyFilter, setNewOnlyFilter] = useState(false);
  // addJobMode determines which destination tab the modal targets:
  //   'applied'      — Applied tab "+ Add Job"
  //   'accepted'     — Accepted tab "+ Add Job"
  //   'interviewing' — Interviewing tab "+ Add Interview" (shows round dropdown)
  //   null           — modal closed
  const [addJobMode, setAddJobMode] = useState<null | 'applied' | 'accepted' | 'interviewing'>(
    null,
  );
  const [newJob, setNewJob] = useState<{
    title: string;
    company: string;
    url: string;
    round: string;
    outcome: string;
  }>({
    title: '',
    company: '',
    url: '',
    round: INTERVIEW_ROUNDS[0],
    outcome: ACCEPTED_OUTCOMES[0],
  });
  const [sortBy, setSortBy] = useState<SortBy>('default');
  // Global "allow bot to submit applications" toggle, persisted in UserModel.settings.
  const [allowAutoSubmit, setAllowAutoSubmit] = useState<boolean>(false);

  // Load settings once on mount.
  useEffect(() => {
    axios
      .get<{ allowAutoSubmit: boolean }>('/api/settings')
      .then((r) => setAllowAutoSubmit(r.data?.allowAutoSubmit === true))
      .catch(() => {
        /* leave at default false */
      });
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

  useEffect(() => {
    fetchJobs();
    fetchCoverLetters();
    fetchPrepareJobs();
  }, [fetchJobs, fetchCoverLetters, fetchPrepareJobs]);

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

  const fetchApplicationTasks = useCallback(async () => {
    try {
      // Only the Applications tab reads history; the job-table badges just need
      // the live ones. Fetching 300 rows every 2.5s regardless was needless.
      const limit = activeTab === 'applications' ? 300 : 100;
      const { data } = await axios.get(`/api/pipeline/tasks?limit=${limit}`);
      setApplicationTasks(data);
    } catch {
      // A failed poll must not blank the table's badges.
    }
  }, [activeTab]);

  // Poll for new jobs every 5 seconds — keeps UI in sync with real-time scoring
  useEffect(() => {
    const interval = setInterval(fetchJobs, 5000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  // Application tasks move faster than jobs do — a worker starts, fails and is
  // requeued well inside one 5s job poll — so they get their own, quicker one.
  useEffect(() => {
    void fetchApplicationTasks();
    const interval = setInterval(fetchApplicationTasks, 2500);
    return () => clearInterval(interval);
  }, [fetchApplicationTasks]);

  /**
   * Newest task per job. The API returns newest first, so the first sighting of
   * a job id is the one that reflects its current state; earlier attempts are
   * history and would otherwise show a stale badge.
   */
  const taskCounts = useMemo(() => countTasks(applicationTasks), [applicationTasks]);

  const taskByJobId = useMemo(() => {
    const map = new Map<string, ApplicationTask>();
    for (const t of applicationTasks) if (!map.has(t.externalJobId)) map.set(t.externalJobId, t);
    return map;
  }, [applicationTasks]);

  const handleDismissJob = useCallback(async (job: ScoredJob) => {
    try {
      await axios.patch(`/api/jobs/${job.id}/status`, {
        status: 'rejected',
        reason: 'Posting no longer available',
      });
      setJobs((prev) =>
        prev.map((j) =>
          j.id === job.id
            ? { ...j, status: 'rejected' as const, reason: 'Posting no longer available' }
            : j,
        ),
      );
    } catch (err) {
      console.error('Failed to dismiss job:', err);
    }
  }, []);

  const handleMarkApplied = useCallback(async (job: ScoredJob) => {
    try {
      await axios.patch(`/api/jobs/${job.id}/status`, { status: 'applied' });
      setJobs((prev) =>
        prev.map((j) =>
          j.id === job.id
            ? { ...j, status: 'applied' as const, applied_at: new Date().toISOString() }
            : j,
        ),
      );
    } catch (err) {
      console.error('Failed to mark applied:', err);
    }
  }, []);

  const handleUpdateStatus = useCallback(
    async (
      job: ScoredJob,
      status: string,
      interviewRound?: string,
      acceptedOutcome?: string,
    ) => {
      try {
        const body: any = { status };
        if (interviewRound !== undefined) body.interview_round = interviewRound;
        if (acceptedOutcome !== undefined) body.accepted_outcome = acceptedOutcome;
        await axios.patch(`/api/jobs/${job.id}/status`, body);
        setJobs((prev) =>
          prev.map((j) =>
            j.id === job.id
              ? {
                  ...j,
                  status: status as any,
                  interview_round:
                    status === 'interviewing' ? (interviewRound ?? j.interview_round) : undefined,
                  accepted_outcome:
                    status === 'accepted' ? (acceptedOutcome ?? j.accepted_outcome) : undefined,
                }
              : j,
          ),
        );
      } catch (err) {
        console.error('Failed to update status:', err);
      }
    },
    [],
  );

  const handleCancelTask = useCallback(async (taskId: string) => {
    try {
      await axios.post(`/api/pipeline/tasks/${taskId}/cancel`);
      await fetchApplicationTasks();
    } catch (err: any) {
      alert(err.response?.data?.message || 'Failed to cancel this application');
    }
  }, [fetchApplicationTasks]);

  const handleRetryTask = useCallback(async (taskId: string) => {
    try {
      await axios.post(`/api/pipeline/tasks/${taskId}/retry`);
      await fetchApplicationTasks();
    } catch (err: any) {
      alert(err.response?.data?.message || 'Failed to retry this application');
    }
  }, [fetchApplicationTasks]);

  const handleAutoApply = useCallback(async (jobIds: string[]): Promise<boolean> => {
    try {
      await axios.post('/api/pipeline/auto-apply', { jobIds });
      // Pull the queue straight away so the row shows Queued rather than
      // sitting on optimistic local state until the next poll.
      await fetchApplicationTasks();
      return true;
    } catch (err: any) {
      const msg = err.response?.data?.message || 'Failed to start auto-apply';
      alert(msg);
      console.error('Failed to start auto-apply:', msg);
      // Returned rather than thrown: the table needs to know so it can drop its
      // optimistic row state, but the other call sites don't await this and a
      // rejection there would surface as an unhandled promise.
      return false;
    }
  }, [fetchApplicationTasks]);

  // Split by status FIRST — these arrays drive the tab badge counts and must
  // reflect totals, not the currently-applied filter (otherwise filtering on
  // Queue makes the Applied/Accepted badges shrink too).
  const queue = jobs.filter((j) => j.status === 'to_apply');

  // A role can sit in the Queue while the same role is already tracked as
  // applied — a scraped record plus a hand-added one, which share no id or URL,
  // so they're matched on trimmed company + title. Rather than hiding the row,
  // the Queue badges it with the status it already has, so it's obvious you've
  // dealt with it without cross-checking the Applied tab.
  const trackedStatusByRole = new Map<string, string>();
  for (const j of jobs) {
    if (TRACKED_STATUSES.includes(j.status)) trackedStatusByRole.set(roleKey(j), j.status);
  }
  // Interviewing and Accepted have their own tabs, so they're pulled out of
  // Applied. 'declined' deliberately stays here: it's a terminal outcome of an
  // application, not a separate stage, so the role keeps its row in Applied
  // with the status dropdown reading "Declined".
  const applied = jobs.filter((j) => ['applied', 'no_response', 'declined'].includes(j.status));
  const interviewing = jobs.filter((j) => j.status === 'interviewing');
  const accepted = jobs.filter((j) => j.status === 'accepted');
  const rejected = jobs.filter((j) => j.status === 'rejected');

  const activeTabJobs =
    activeTab === 'queue'
      ? queue
      : activeTab === 'applied'
        ? applied
        : activeTab === 'interviewing'
          ? interviewing
          : activeTab === 'accepted'
            ? accepted
            : rejected;

  // Filters apply ONLY to the currently-visible tab. State persists across tab
  // switches (so a search query carries over if you flip to a different tab to
  // look up the same company), but other tabs' counts are unaffected.
  const byPlatform =
    platformFilter === 'all'
      ? activeTabJobs
      : activeTabJobs.filter((j) => j.source === platformFilter);
  const byScore =
    scoreFilter > 0 ? byPlatform.filter((j) => j.fit_score === scoreFilter) : byPlatform;
  const byNew = newOnlyFilter
    ? byScore.filter((j) => Date.now() - new Date(j.scraped_at).getTime() < 86400000)
    : byScore;
  const tabJobs = searchQuery
    ? byNew.filter(
        (j) =>
          j.company.toLowerCase().includes(searchQuery.toLowerCase()) ||
          j.title.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : byNew;

  if (loading) {
    return (
      <div className="container">
        <div className="app-header">
          <h1>JobPilot</h1>
        </div>
        <div className="empty-state">
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="app-header">
        <h1>JobPilot</h1>
        <label
          className={`auto-submit-toggle ${allowAutoSubmit ? 'on' : 'off'}`}
          title={
            allowAutoSubmit
              ? 'Bot is ALLOWED to click Submit on every auto-apply. Click to disable (dry-run).'
              : 'Bot will fill forms but STOP before Submit. Click to enable real submissions.'
          }
        >
          <input type="checkbox" checked={allowAutoSubmit} onChange={toggleAllowAutoSubmit} />
          <span className="auto-submit-dot" />
          <span className="auto-submit-label">
            Auto-submit: {allowAutoSubmit ? 'ON' : 'OFF (dry-run)'}
          </span>
        </label>
        <div className="hamburger-wrapper">
          <button className="hamburger-btn" onClick={() => setMenuOpen(!menuOpen)}>
            <span />
            <span />
            <span />
          </button>
          {menuOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="hamburger-menu">
                <button
                  onClick={() => {
                    setProfileOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  Candidate Profile
                </button>
                <button
                  onClick={() => {
                    setKeywordManagerOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  Keywords
                </button>
                <button
                  onClick={() => {
                    setFormAnswersOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  Saved Rules
                </button>
                <button
                  onClick={() => {
                    setCommandPanelOpen(true);
                    setMenuOpen(false);
                  }}
                >
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
        counts={{
          queue: queue.length,
          applied: applied.length,
          interviewing: interviewing.length,
          accepted: accepted.length,
          rejected: rejected.length,
          coverLetters: coverLetterJobs.length,
          prepare: prepareJobs.filter((p: any) => p.status !== 'applied').length,
          applications: taskCounts.attention,
        }}
        applicationsNeedReview={taskCounts.needsReview}
        onOpenCommands={() => setCommandPanelOpen(true)}
        onOpenKeywords={() => setKeywordManagerOpen(true)}
      />

      {activeTab !== 'cover-letters' && activeTab !== 'prepare' && activeTab !== 'applications' && (
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
                <button className="search-clear" onClick={() => setSearchQuery('')}>
                  &times;
                </button>
              )}
            </div>
            <div className="platform-filter">
              {(
                ['all', 'linkedin', 'greenhouse', 'ashby', 'lever', 'indeed'] as PlatformFilter[]
              ).map((p) => (
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
              <button className="select-to-apply-btn" onClick={() => setAddJobMode('applied')}>
                + Add Job
              </button>
            )}
            {activeTab === 'accepted' && (
              <button className="select-to-apply-btn" onClick={() => setAddJobMode('accepted')}>
                + Add Job
              </button>
            )}
            {activeTab === 'interviewing' && (
              <button className="select-to-apply-btn" onClick={() => setAddJobMode('interviewing')}>
                + Add Interview
              </button>
            )}
          </div>
          <JobTable
            jobs={tabJobs}
            activeTab={activeTab}
            selectMode={autoApplyMode}
            sortBy={sortBy}
            trackedStatusByRole={trackedStatusByRole}
            onSelectJob={setSelectedJob}
            onDismissJob={handleDismissJob}
            onMarkApplied={handleMarkApplied}
            onUpdateStatus={handleUpdateStatus}
            onAutoApply={(ids) => {
              handleAutoApply(ids);
              setAutoApplyMode(false);
            }}
            onCancelSelect={() => setAutoApplyMode(false)}
            taskByJobId={taskByJobId}
            onRetryTask={handleRetryTask}
          />
        </>
      )}

      {activeTab === 'applications' && (
        <ApplicationsView
          tasks={applicationTasks}
          onRetryTask={handleRetryTask}
          onCancelTask={handleCancelTask}
        />
      )}

      {activeTab === 'prepare' && (
        <PrepareReview
          jobs={prepareJobs}
          onRefresh={fetchPrepareJobs}
          onAutoApply={handleAutoApply}
          onDismissJob={async (jobId) => {
            try {
              await axios.patch(`/api/jobs/${jobId}/status`, {
                status: 'rejected',
                reason: 'Removed from prepare list',
              });
              fetchJobs();
            } catch {
              /* ignore */
            }
          }}
        />
      )}

      {activeTab === 'cover-letters' && (
        <CoverLettersPage jobs={coverLetterJobs} onRefresh={fetchCoverLetters} />
      )}

      {selectedJob && (
        <JobDetail
          job={selectedJob}
          onClose={() => setSelectedJob(null)}
          onJobUpdate={(updated) => {
            setSelectedJob(updated);
            setJobs((prev) => prev.map((j) => (j.id === updated.id ? updated : j)));
          }}
        />
      )}
      <CommandPanel
        isOpen={commandPanelOpen}
        onClose={handleClosePanel}
        onComplete={handleCommandComplete}
      />
      <KeywordManager isOpen={keywordManagerOpen} onClose={() => setKeywordManagerOpen(false)} />
      <ProfileEditor isOpen={profileOpen} onClose={() => setProfileOpen(false)} />
      <FormAnswers isOpen={formAnswersOpen} onClose={() => setFormAnswersOpen(false)} />
      <PendingQuestion />
      {addJobMode &&
        (() => {
          const closeModal = () => {
            setAddJobMode(null);
            setNewJob({
              title: '',
              company: '',
              url: '',
              round: INTERVIEW_ROUNDS[0],
              outcome: ACCEPTED_OUTCOMES[0],
            });
          };
          const heading =
            addJobMode === 'interviewing'
              ? 'Add Interview'
              : addJobMode === 'accepted'
                ? 'Add Accepted Offer'
                : 'Add External Application';
          const hint =
            addJobMode === 'interviewing'
              ? 'Track a company you are currently interviewing with.'
              : addJobMode === 'accepted'
                ? 'Track a role you accepted outside this app.'
                : 'Track a job you applied to outside this app.';
          const buttonLabel =
            addJobMode === 'interviewing'
              ? 'Add to Interviewing'
              : addJobMode === 'accepted'
                ? 'Add to Accepted'
                : 'Add to Applied';
          return (
            <div className="modal-overlay" onClick={closeModal}>
              <div className="add-job-modal" onClick={(e) => e.stopPropagation()}>
                <h3>{heading}</h3>
                <p className="add-job-hint">{hint}</p>
                <div className="add-job-form">
                  <input
                    placeholder="Position *"
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
                  {addJobMode === 'interviewing' && (
                    <select
                      className="status-dropdown"
                      value={newJob.round}
                      onChange={(e) => setNewJob({ ...newJob, round: e.target.value })}
                    >
                      {INTERVIEW_ROUNDS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  )}
                  {addJobMode === 'accepted' && (
                    <select
                      className="status-dropdown"
                      value={newJob.outcome}
                      onChange={(e) => setNewJob({ ...newJob, outcome: e.target.value })}
                    >
                      {ACCEPTED_OUTCOMES.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  )}
                  <div className="add-job-actions">
                    <button className="prepare-cancel-btn" onClick={closeModal}>
                      Cancel
                    </button>
                    <button
                      className="auto-apply-btn"
                      disabled={!newJob.title.trim() || !newJob.company.trim()}
                      onClick={async () => {
                        try {
                          const payload: any = {
                            title: newJob.title,
                            company: newJob.company,
                            url: newJob.url,
                            status: addJobMode,
                          };
                          if (addJobMode === 'interviewing') {
                            payload.interview_round = newJob.round;
                          }
                          if (addJobMode === 'accepted') {
                            payload.accepted_outcome = newJob.outcome;
                          }
                          await axios.post('/api/jobs/manual', payload);
                          closeModal();
                          fetchJobs();
                        } catch (err) {
                          console.error('Failed to add job:', err);
                        }
                      }}
                    >
                      {buttonLabel}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
