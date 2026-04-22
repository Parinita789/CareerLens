// Eval harness for auto-apply form answers. Runs the real `answerQuestion`
// function (scorer/question-answerer.ts) against a fixture of question+expected
// pairs. Meant to be invoked on demand (npm run eval:answers) — not part of
// `npm test`, because it hits the live LLM and takes ~1-2 min per run.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

import { connectToDatabase, disconnectDatabase } from '../db';
import { answerQuestion } from '../scorer/question-answerer';

interface Expect {
  equals?: string;
  includes?: string | string[];
  oneOf?: string[];
  notIncludes?: string[];
  regex?: string;
  minLength?: number;
  maxLength?: number;
}

interface Case {
  name: string;
  question: string;
  type: 'text' | 'textarea' | 'select' | 'radio';
  options?: string[];
  expect: Expect;
  notes?: string;
}

interface GradeResult { ok: boolean; reason?: string; }

function grade(actual: string, expected: Expect): GradeResult {
  const a = (actual ?? '').trim();
  if (expected.equals !== undefined) {
    if (a !== expected.equals) return { ok: false, reason: `equals mismatch: want "${expected.equals}", got "${a}"` };
  }
  if (expected.includes !== undefined) {
    const needles = Array.isArray(expected.includes) ? expected.includes : [expected.includes];
    for (const n of needles) {
      if (!a.includes(n)) return { ok: false, reason: `missing substring "${n}" in "${a.slice(0, 80)}"` };
    }
  }
  if (expected.oneOf !== undefined) {
    if (!expected.oneOf.includes(a)) return { ok: false, reason: `not in oneOf ${JSON.stringify(expected.oneOf)}: got "${a}"` };
  }
  if (expected.notIncludes !== undefined) {
    for (const banned of expected.notIncludes) {
      if (a.toLowerCase().includes(banned.toLowerCase())) return { ok: false, reason: `contains banned phrase "${banned}"` };
    }
  }
  if (expected.regex !== undefined) {
    if (!new RegExp(expected.regex).test(a)) return { ok: false, reason: `regex /${expected.regex}/ did not match "${a.slice(0, 80)}"` };
  }
  if (expected.minLength !== undefined && a.length < expected.minLength) {
    return { ok: false, reason: `too short: ${a.length} < ${expected.minLength}` };
  }
  if (expected.maxLength !== undefined && a.length > expected.maxLength) {
    return { ok: false, reason: `too long: ${a.length} > ${expected.maxLength}` };
  }
  return { ok: true };
}

function pad(s: string, n: number) { return s.length >= n ? s : s + ' '.repeat(n - s.length); }

async function main() {
  const fixturePath = path.join(__dirname, 'fixtures/answer-cases.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as { cases: any[] };
  // Drop section-header entries ({"$comment": "..."}) — readability only, not cases.
  const cases: Case[] = fixture.cases.filter((c) => c && c.name && c.question);

  console.log(`\nRunning ${cases.length} cases against answerQuestion ...\n`);
  await connectToDatabase();

  let passed = 0;
  const failures: Array<{ c: Case; actual: string; reason: string; ms: number }> = [];
  let totalLlmMs = 0, llmCount = 0;

  for (const c of cases) {
    const t0 = Date.now();
    let actual = '';
    let errorMsg = '';
    try {
      actual = await answerQuestion(c.question, c.type, c.options);
    } catch (err) {
      errorMsg = (err as Error).message;
    }
    const ms = Date.now() - t0;
    // Rule-hit calls return almost instantly; LLM calls take seconds. Use a
    // simple threshold to attribute latency.
    const via = ms < 500 ? 'rule' : 'llm';
    if (via === 'llm') { totalLlmMs += ms; llmCount++; }

    const result = errorMsg
      ? { ok: false, reason: `ERROR: ${errorMsg}` }
      : grade(actual, c.expect);

    const marker = result.ok ? '✓' : '✗';
    const msStr = `${ms.toString().padStart(5)}ms`;
    console.log(`  ${marker} ${pad(c.name, 42)} ${pad(c.type, 8)} → ${pad(via, 4)}  ${msStr}   ${result.ok ? preview(actual) : result.reason}`);

    if (result.ok) passed++;
    else failures.push({ c, actual, reason: result.reason ?? 'unknown', ms });
  }

  const pct = Math.round((passed / cases.length) * 100);
  const avgLlm = llmCount > 0 ? Math.round(totalLlmMs / llmCount) : 0;
  console.log(`\n${cases.length} cases: ${passed} passed, ${failures.length} failed (${pct}%)  avg LLM latency ${avgLlm}ms over ${llmCount} LLM calls\n`);

  if (failures.length > 0) {
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  - ${f.c.name}: ${f.reason}`);
      console.log(`      question: "${f.c.question}"`);
      console.log(`      actual:   "${(f.actual || '').slice(0, 160)}"`);
    }
    console.log('');
  }

  await disconnectDatabase();
  process.exit(failures.length > 0 ? 1 : 0);
}

function preview(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `"${oneLine.slice(0, 57)}..."` : `"${oneLine}"`;
}

main().catch((err) => {
  console.error('FATAL:', (err as Error).message);
  process.exit(2);
});
