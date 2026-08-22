import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { connectToDatabase, disconnectDatabase, JobModel, CoverLetterModel, UserModel, QuestionAnswerModel, ProfileAnswerModel } from '@job-agent/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

export { connectToDatabase, disconnectDatabase };
export { JobModel, CoverLetterModel, UserModel, QuestionAnswerModel, ProfileAnswerModel };

// ── Deliberately plain functions, not ScraperPersistenceService methods ──
// loadProfile/loadAnswerRules/saveCoverLetter are stateless DB reads/writes — any caller
// gets identical, correct behavior whether they import the plain function or go through a
// service, so there's no correctness reason to wrap them. logQuestionAnswer and the
// answer-source-stats counter (resetAnswerSourceStats/getAnswerSourceStats) are the one
// case that DOES carry shared state (the per-run rule/llm tally), but since it's a
// module-level singleton — the same as any other ES module import — every caller across
// the whole apply/ and sourcing/ tree already reads and writes the same `_stats` object
// regardless of whether it's DI-injected or plainly imported. Wrapping it in a class would
// only be worth it if some callers needed a *different* instance, which none do.

export async function saveCoverLetter(externalJobId: string, content: string, rawContent?: string): Promise<void> {
  const job = await JobModel.findOne({ externalId: externalJobId });
  await CoverLetterModel.findOneAndUpdate(
    { externalJobId },
    {
      $set: {
        jobId: job?._id,
        content,
        ...(rawContent !== undefined ? { rawContent } : {}),
        generatedAt: new Date(),
      },
    },
    { upsert: true },
  );
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
