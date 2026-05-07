import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { connectToDatabase, disconnectDatabase, JobModel, CoverLetterModel, UserModel, QuestionAnswerModel, ProfileAnswerModel } from '@job-agent/shared';
import type { ScoredJob } from './types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../.env') });

export { connectToDatabase, disconnectDatabase };
export { JobModel, CoverLetterModel, UserModel, QuestionAnswerModel, ProfileAnswerModel };

export async function loadExistingJobs(): Promise<ScoredJob[]> {
  const jobs = await JobModel.find().lean();
  return jobs.map(jobDocToScoredJob);
}

export async function saveJob(job: ScoredJob): Promise<void> {
  await JobModel.findOneAndUpdate(
    { externalId: job.id },
    { $set: jobToDoc(job) },
    { upsert: true },
  );
}

export async function saveJobs(jobs: ScoredJob[]): Promise<void> {
  if (jobs.length === 0) return;
  const ops = jobs.map((job) => ({
    updateOne: {
      filter: { externalId: job.id },
      update: { $set: jobToDoc(job) },
      upsert: true,
    },
  }));
  await JobModel.bulkWrite(ops);
}

export async function saveCoverLetter(externalJobId: string, content: string): Promise<void> {
  const job = await JobModel.findOne({ externalId: externalJobId });
  await CoverLetterModel.findOneAndUpdate(
    { externalJobId },
    {
      $set: {
        jobId: job?._id,
        content,
        generatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

export async function getBestCoverLetters(limit: number = 3): Promise<{ title: string; company: string; content: string }[]> {
  // Get cover letters linked to highest-scoring jobs, from different companies
  const coverLetters = await CoverLetterModel.find().sort({ generatedAt: -1 }).lean();
  if (coverLetters.length === 0) return [];

  const jobIds = coverLetters.map((cl: any) => cl.externalJobId);
  const jobs = await JobModel.find({ externalId: { $in: jobIds } }).lean();
  const jobMap = new Map(jobs.map((j: any) => [j.externalId, j]));

  // Pair cover letters with jobs, sort by fit_score, pick top from different companies
  const paired = coverLetters
    .map((cl: any) => {
      const job = jobMap.get(cl.externalJobId);
      if (!job || !cl.content || cl.content.length < 50) return null;
      return { title: job.title, company: job.company, content: cl.content, score: job.fit_score || 0 };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.score - a.score);

  const seen = new Set<string>();
  const results: { title: string; company: string; content: string }[] = [];
  for (const item of paired) {
    if (seen.has(item!.company)) continue;
    seen.add(item!.company);
    results.push({ title: item!.title, company: item!.company, content: item!.content });
    if (results.length >= limit) break;
  }

  return results;
}

export async function loadProfile(): Promise<any> {
  return UserModel.findOne().lean();
}

export async function loadAnswerRules(): Promise<Record<string, string>> {
  const rules = await ProfileAnswerModel.find().lean();
  return rules.reduce((acc: Record<string, string>, r: any) => {
    acc[r.question_pattern] = r.answer;
    return acc;
  }, {});
}

// In-memory per-run audit of where Q&A answers came from. Phase 4 reads
// these via getAnswerSourceStats at the end of a run to print a "X by rule,
// Y by LLM" summary. Resets between runs via resetAnswerSourceStats.
interface AnswerSourceStats {
  rule: number;
  llm: number;
  perJob: Record<string, { rule: number; llm: number; title: string; company: string }>;
}
const _stats: AnswerSourceStats = { rule: 0, llm: 0, perJob: {} };

export function resetAnswerSourceStats(): void {
  _stats.rule = 0;
  _stats.llm = 0;
  _stats.perJob = {};
}

export function getAnswerSourceStats(): Readonly<AnswerSourceStats> {
  return _stats;
}

export async function logQuestionAnswer(
  jobId: string, title: string, company: string,
  entry: { question: string; type: string; options?: string[]; answer: string; source: 'rule' | 'llm' },
): Promise<void> {
  // Bump in-memory counters before any DB I/O so a Mongo failure doesn't
  // lose the audit signal. Skip empty-answer logs (those are skips, not answers).
  if (entry.answer && entry.answer.length > 0) {
    _stats[entry.source]++;
    const per = _stats.perJob[jobId] ?? { rule: 0, llm: 0, title, company };
    per[entry.source]++;
    _stats.perJob[jobId] = per;
  }

  // Strip options if too many (country lists etc.) or contain phone codes
  const cleanEntry = { ...entry };
  if (cleanEntry.options) {
    if (cleanEntry.options.length > 15 || cleanEntry.options.some((o) => o.includes('+93') || o.includes('Afghanistan'))) {
      delete cleanEntry.options;
    }
  }

  // Check if this question already exists for this job — update instead of duplicating
  const existing = await QuestionAnswerModel.findOne({ externalJobId: jobId }).lean();
  if (existing) {
    const answers = (existing as any).answers || [];
    const idx = answers.findIndex((a: any) => a.question === cleanEntry.question);
    if (idx >= 0) {
      // Update existing answer
      answers[idx] = cleanEntry;
    } else {
      answers.push(cleanEntry);
    }
    await QuestionAnswerModel.updateOne(
      { externalJobId: jobId },
      { $set: { answers, appliedAt: new Date() } },
    );
  } else {
    await QuestionAnswerModel.create({
      externalJobId: jobId,
      title,
      company,
      appliedAt: new Date(),
      answers: [cleanEntry],
    });
  }
}

// ── Mapping helpers ──

function jobToDoc(job: ScoredJob): Record<string, any> {
  return {
    externalId: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    remote: job.remote,
    employment_type: job.employment_type,
    salary_min: job.salary_min,
    salary_max: job.salary_max,
    description: job.description,
    url: job.url,
    source: job.source,
    scraped_at: job.scraped_at ? new Date(job.scraped_at) : new Date(),
    posted_at: job.posted_at ? new Date(job.posted_at) : null,
    fit_score: job.fit_score,
    apply: job.apply,
    matched_skills: job.matched_skills,
    missing_skills: job.missing_skills,
    reason: job.reason,
    deal_breaker: job.deal_breaker,
    status: job.status,
    applied_at: job.applied_at ? new Date(job.applied_at) : null,
    applied_via: job.applied_via || null,
    notes: job.notes || '',
  };
}

function jobDocToScoredJob(doc: any): ScoredJob {
  return {
    id: doc.externalId,
    title: doc.title,
    company: doc.company,
    location: doc.location || '',
    remote: doc.remote || false,
    employment_type: doc.employment_type || 'full-time',
    salary_min: doc.salary_min,
    salary_max: doc.salary_max,
    description: doc.description || '',
    url: doc.url || '',
    source: doc.source || 'linkedin',
    scraped_at: doc.scraped_at?.toISOString?.() || '',
    posted_at: doc.posted_at?.toISOString?.(),
    fit_score: doc.fit_score || 0,
    apply: doc.apply || false,
    matched_skills: doc.matched_skills || [],
    missing_skills: doc.missing_skills || [],
    reason: doc.reason || '',
    deal_breaker: doc.deal_breaker,
    status: doc.status || 'to_apply',
    applied_at: doc.applied_at?.toISOString?.(),
    applied_via: doc.applied_via,
    notes: doc.notes,
  };
}
