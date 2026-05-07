export type JobSource = 'linkedin' | 'greenhouse' | 'lever' | 'indeed';
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
  cover_letter?: string;
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
