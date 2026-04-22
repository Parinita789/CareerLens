// Eval harness for the cover-letter LLM path.
//   npm run eval:cover-letters
// Calls the real generateCoverLetter(job) from @job-agent/shared and grades the
// output against a fixture of {job → expectations} pairs.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

import { connectToDatabase, disconnectDatabase } from '../db';
import { generateCoverLetter } from '@job-agent/shared';
import { grade, pad, preview, type Expect } from './_lib';

interface Case {
  name: string;
  job: {
    title: string;
    company: string;
    location?: string;
    description: string;
    matched_skills?: string[];
    reason?: string;
  };
  expect: Expect;
  notes?: string;
}

async function main() {
  const fixturePath = path.join(__dirname, 'fixtures/cover-letter-cases.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as { cases: Case[] };
  const cases = fixture.cases;

  console.log(`\nRunning ${cases.length} cases against generateCoverLetter ...\n`);
  await connectToDatabase();

  let passed = 0;
  const failures: Array<{ c: Case; actual: string; reason: string; ms: number }> = [];
  let totalMs = 0;

  for (const c of cases) {
    const t0 = Date.now();
    let actual = '';
    let errorMsg = '';
    try {
      actual = await generateCoverLetter(c.job as any);
    } catch (err) {
      errorMsg = (err as Error).message;
    }
    const ms = Date.now() - t0;
    totalMs += ms;

    const result = errorMsg
      ? { ok: false, reason: `ERROR: ${errorMsg}` }
      : grade(actual, c.expect);

    const marker = result.ok ? '✓' : '✗';
    const msStr = `${ms.toString().padStart(6)}ms`;
    console.log(`  ${marker} ${pad(c.name, 32)} ${msStr}   ${result.ok ? `${actual.length} chars — ${preview(actual)}` : result.reason}`);

    if (result.ok) passed++;
    else failures.push({ c, actual, reason: result.reason ?? 'unknown', ms });
  }

  const pct = Math.round((passed / cases.length) * 100);
  const avgMs = Math.round(totalMs / cases.length);
  console.log(`\n${cases.length} cases: ${passed} passed, ${failures.length} failed (${pct}%)  avg latency ${avgMs}ms\n`);

  if (failures.length > 0) {
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  - ${f.c.name}: ${f.reason}`);
      console.log(`      job: "${f.c.job.title}" @ ${f.c.job.company}`);
      console.log(`      actual (first 220 chars): "${(f.actual || '').slice(0, 220).replace(/\s+/g, ' ')}"`);
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
