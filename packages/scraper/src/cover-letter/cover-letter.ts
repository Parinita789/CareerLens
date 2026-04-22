// Thin shim — generation logic lives in @job-agent/shared. Kept here so the
// scraper-side callers (phase3, phase4, greenhouse-apply, form-scraper) can
// use their existing relative import path.

import { generateCoverLetter as sharedGenerateCoverLetter } from '@job-agent/shared';
import { connectToDatabase, disconnectDatabase, loadExistingJobs, saveJob, saveCoverLetter } from '../db';
import type { ScoredJob } from '../types';

export async function generateCoverLetter(job: ScoredJob): Promise<string> {
  return sharedGenerateCoverLetter(job);
}

export async function generateAllCoverLetters(
  minScore: number,
  force = false,
  specificJobIds?: string[] | null,
): Promise<void> {
  await connectToDatabase();

  const jobs: ScoredJob[] = await loadExistingJobs();

  const eligible = specificJobIds
    ? jobs.filter((j) => specificJobIds.includes(j.id) && (force || !j.cover_letter))
    : jobs.filter((j) => j.fit_score >= minScore && j.status === 'to_apply' && (force || !j.cover_letter));

  console.log(`${specificJobIds ? 'Selected' : 'Found'} ${eligible.length} jobs for cover letter generation.\n`);

  if (eligible.length === 0) {
    await disconnectDatabase();
    return;
  }

  for (const job of eligible) {
    console.log(`Generating cover letter for: ${job.title} @ ${job.company}`);

    try {
      const coverLetter = await sharedGenerateCoverLetter(job);
      job.cover_letter = coverLetter;

      await saveCoverLetter(job.id, coverLetter);
      await saveJob(job);

      console.log(`  Done (${coverLetter.length} chars)\n`);
    } catch (err) {
      console.error(`  Failed: ${(err as Error).message}\n`);
    }
  }

  console.log(`Saved ${eligible.length} cover letters to database.`);

  await disconnectDatabase();
}
