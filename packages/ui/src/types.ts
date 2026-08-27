// Deliberately declared here rather than imported from @job-agent/shared: that
// package's barrel also exports the Mongoose schemas, DB connection and LLM
// clients, none of which belong in a browser bundle. Keep this union in step
// with the shared one — it had gone stale and omitted 'ashby', which is one of
// the busiest sources.
export type JobSource = 'linkedin' | 'greenhouse' | 'lever' | 'indeed' | 'ashby';
export type JobStatus = 'to_apply' | 'applied' | 'rejected' | 'no_response' | 'interviewing' | 'accepted' | 'declined';

export interface ScoredJob {
  id: string;
  title: string;
  company: string;
  location: string;
  remote: boolean;
  employment_type: string;
  salary_min?: number;
  salary_max?: number;
  description: string;
  url: string;
  source: JobSource;
  scraped_at: string;
  posted_at?: string;
  fit_score: number;
  apply: boolean;
  matched_skills: string[];
  missing_skills: string[];
  reason: string;
  deal_breaker?: string;
  status: JobStatus;
  applied_at?: string;
  applied_via?: 'auto' | 'manual';
  interview_round?: string;
  accepted_outcome?: string;
  cover_letter?: string;
  cover_letter_raw?: string;
  notes?: string;
}

export interface PipelineStatus {
  running: boolean;
  phase: string | null;
  command: string | null;
  error: string | null;
  lastRunAt: string | null;
  logs: string[];
}

export interface PipelineCommand {
  id: string;
  label: string;
}

export interface AlertKeyword {
  id: string;
  keywords: string;
  location: string;
  label: string;
}

/**
 * One queued application to one job. Mirrors the ApplicationTask collection —
 * see the note above for why these types are declared here rather than imported
 * from @job-agent/shared.
 */
export type ApplicationTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'needs_review'
  | 'cancelled';

export interface ApplicationTask {
  _id: string;
  externalJobId: string;
  title?: string;
  company?: string;
  status: ApplicationTaskStatus;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  /** Set means the application may already have reached the employer. */
  submitAttemptedAt?: string;
  createdAt: string;
  finishedAt?: string;
}
