// Eval harness for preAnswerFields — the bulk form filler used during
// auto-apply. Unlike the other harnesses, this one also verifies WHICH layer
// (rule / profile / llm) answered each field, enforcing the "LLM is last
// option" contract.
//   npm run eval:form-pre-answer

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

import { connectToDatabase, disconnectDatabase } from '../persistence/db';
import { preAnswerFields } from '../answer-resolution/form-pre-answerer.service';
import { grade, pad, preview, type Expect } from './_lib';

interface FieldFixture {
  fieldId: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
  value: string;
  source: 'profile' | 'rule' | 'llm' | 'unknown';
}

interface FieldExpect {
  expect: Expect;
  sourceIn: Array<'profile' | 'rule' | 'llm' | 'unknown'>;
}

interface Case {
  name: string;
  job: any;
  fields: FieldFixture[];
  expectPerField: Record<string, FieldExpect>;
  notes?: string;
}

async function main() {
  const fixturePath = path.join(__dirname, 'fixtures/form-pre-answerer-cases.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as { cases: Case[] };
  const cases = fixture.cases;

  const totalFields = cases.reduce((acc, c) => acc + c.fields.length, 0);
  console.log(`\nRunning ${cases.length} case(s), ${totalFields} fields total, through preAnswerFields ...\n`);
  await connectToDatabase();

  let passed = 0;
  let failed = 0;
  const failures: Array<{ caseName: string; fieldId: string; label: string; actualValue: string; actualSource: string; reason: string }> = [];

  for (const c of cases) {
    console.log(`─ Case: ${c.name}`);
    const t0 = Date.now();
    const filled = await preAnswerFields(c.fields as any, c.job as any);
    const totalMs = Date.now() - t0;

    for (const field of filled) {
      const spec = c.expectPerField[field.fieldId];
      if (!spec) continue;

      const valueResult = grade(field.value, spec.expect);
      const sourceOk = spec.sourceIn.includes(field.source);

      let resultOk = valueResult.ok && sourceOk;
      let reason = '';
      if (!valueResult.ok) reason = valueResult.reason ?? 'value mismatch';
      else if (!sourceOk) reason = `source "${field.source}" not in allowed ${JSON.stringify(spec.sourceIn)}`;

      const marker = resultOk ? '✓' : '✗';
      console.log(`    ${marker} ${pad(field.fieldId, 14)} ${pad(field.source, 7)} ${pad(field.label.slice(0, 32), 34)} ${resultOk ? preview(field.value) : reason}`);

      if (resultOk) passed++;
      else { failed++; failures.push({ caseName: c.name, fieldId: field.fieldId, label: field.label, actualValue: field.value, actualSource: field.source, reason }); }
    }

    console.log(`  (case completed in ${totalMs}ms)\n`);
  }

  const total = passed + failed;
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  console.log(`${total} field assertions: ${passed} passed, ${failed} failed (${pct}%)\n`);

  if (failures.length > 0) {
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  - [${f.caseName}/${f.fieldId}] ${f.label}`);
      console.log(`      actual: value="${f.actualValue.slice(0, 100)}" source="${f.actualSource}"`);
      console.log(`      reason: ${f.reason}`);
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
