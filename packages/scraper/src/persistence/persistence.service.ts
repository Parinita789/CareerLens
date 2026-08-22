import { Injectable } from '@nestjs/common';
import { JobModel, CoverLetterModel } from './db';
import type { ScoredJob } from '../types';

@Injectable()
export class ScraperPersistenceService {
  async loadExistingJobs(): Promise<ScoredJob[]> {
    const jobs = await JobModel.find().lean();
    return jobs.map(jobDocToScoredJob);
  }

  async saveJob(job: ScoredJob): Promise<void> {
    await JobModel.findOneAndUpdate(
      { externalId: job.id },
      { $set: jobToDoc(job) },
      { upsert: true },
    );
  }

  async saveJobs(jobs: ScoredJob[]): Promise<void> {
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

  async getBestCoverLetters(limit: number = 3): Promise<{ title: string; company: string; content: string }[]> {
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
