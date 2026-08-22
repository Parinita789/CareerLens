// Eval harness for the LLM fit-scorer (scoreFitWithLLM).
//   npm run eval:scorer
// Grades fit_score within a range + matched_skills inclusion + missing_skills
// exclusion (catches LLMs that "miss" skills the profile actually has).

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

import { connectToDatabase, disconnectDatabase } from '../persistence/db';
import { LlmScorerService } from '../scoring/llm-scorer.service';
import { gradeRange, gradeArrayIncludes, gradeArrayExcludes, pad, type RangeExpect } from './_lib';

const llmScorer = new LlmScorerService();

interface Expect {
  fit_score?: RangeExpect;
  matched_skills_include?: string[];
  missing_skills_excludes?: string[];
  reasonMinLength?: number;
  reasonIncludes?: string[];
}

interface Case {
  name: string;
  job: any;
  expect: Expect;
  notes?: string;
}

interface ScoreOutput {
  fit_score: number;
  matched_skills: string[];
  missing_skills: string[];
  reason: string;
  apply: boolean;
}

function gradeScore(actual: ScoreOutput, exp: Expect): { ok: boolean; reason?: string } {
  if (exp.fit_score) {
    const r = gradeRange(actual.fit_score, exp.fit_score, 'fit_score');
    if (!r.ok) return r;
  }
  if (exp.matched_skills_include) {
    const r = gradeArrayIncludes(actual.matched_skills ?? [], exp.matched_skills_include, 'matched_skills');
    if (!r.ok) return r;
  }
  if (exp.missing_skills_excludes) {
    const r = gradeArrayExcludes(actual.missing_skills ?? [], exp.missing_skills_excludes, 'missing_skills');
    if (!r.ok) return r;
  }
  if (exp.reasonMinLength !== undefined && (actual.reason ?? '').length < exp.reasonMinLength) {
    return { ok: false, reason: `reason too short: ${(actual.reason ?? '').length} < ${exp.reasonMinLength}` };
  }
  if (exp.reasonIncludes) {
    const lower = (actual.reason ?? '').toLowerCase();
    for (const kw of exp.reasonIncludes) {
      if (!lower.includes(kw.toLowerCase())) return { ok: false, reason: `reason missing keyword "${kw}"` };
    }
  }
  return { ok: true };
}

async function main() {
  const fixturePath = path.join(__dirname, 'fixtures/scorer-cases.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as { cases: Case[] };
  const cases = fixture.cases;

  console.log(`\nRunning ${cases.length} cases against scoreFitWithLLM ...\n`);
  await connectToDatabase();

  let passed = 0;
  const failures: Array<{ c: Case; actual: ScoreOutput; reason: string; ms: number }> = [];
  let totalMs = 0;

  for (const c of cases) {
    const t0 = Date.now();
    let actual: ScoreOutput | null = null;
    let errorMsg = '';
    try {
      actual = (await llmScorer.scoreFitWithLLM(c.job)) as ScoreOutput;
    } catch (err) {
      errorMsg = (err as Error).message;
    }
    const ms = Date.now() - t0;
    totalMs += ms;

    const result = errorMsg
      ? { ok: false, reason: `ERROR: ${errorMsg}` }
      : gradeScore(actual!, c.expect);

    const marker = result.ok ? '✓' : '✗';
    const scoreStr = actual ? `${actual.fit_score}/10` : 'n/a';
    const msStr = `${ms.toString().padStart(5)}ms`;
    const matchedPreview = (actual?.matched_skills ?? []).slice(0, 3).join(', ');
    console.log(`  ${marker} ${pad(c.name, 36)} score=${pad(scoreStr, 5)} ${msStr}   ${result.ok ? `matched=[${matchedPreview}]` : result.reason}`);

    if (result.ok) passed++;
    else failures.push({ c, actual: actual ?? ({} as any), reason: result.reason ?? 'unknown', ms });
  }

  const pct = Math.round((passed / cases.length) * 100);
  const avgMs = Math.round(totalMs / cases.length);
  console.log(`\n${cases.length} cases: ${passed} passed, ${failures.length} failed (${pct}%)  avg latency ${avgMs}ms\n`);

  if (failures.length > 0) {
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  - ${f.c.name}: ${f.reason}`);
      console.log(`      job: "${f.c.job.title}"`);
      console.log(`      actual: fit_score=${f.actual.fit_score}  matched=${JSON.stringify(f.actual.matched_skills)}  missing=${JSON.stringify(f.actual.missing_skills)}`);
      console.log(`      reason: "${(f.actual.reason || '').slice(0, 200)}"`);
    }
    console.log('');
  }

  await disconnectDatabase();
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', (err as Error).message);
  process.exit(2);
});
