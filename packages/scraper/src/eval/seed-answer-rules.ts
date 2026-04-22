import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

import { connectToDatabase, disconnectDatabase } from '../db';
import { ProfileAnswerModel } from '@job-agent/shared';

const CANONICAL_RULES: Record<string, string> = {
  remote: 'Yes',
  'expected salary': '150000',
  'desired salary': '150000',
  'salary expectation': '150000',
  'years of experience in typescript': '5',
  'years of experience in javascript': '3',
  'years of experience in go': '1',
  'years of experience in aws': '4',
};

async function main() {
  await connectToDatabase();

  let inserted = 0,
    updated = 0,
    unchanged = 0;
  for (const [pattern, answer] of Object.entries(CANONICAL_RULES)) {
    const existing = await ProfileAnswerModel.findOne({ question_pattern: pattern }).lean();
    if (!existing) {
      await ProfileAnswerModel.create({ question_pattern: pattern, answer });
      console.log(`  + "${pattern}" → "${answer}"  (new)`);
      inserted++;
    } else if ((existing as any).answer !== answer) {
      await ProfileAnswerModel.updateOne({ question_pattern: pattern }, { $set: { answer } });
      console.log(`  ~ "${pattern}" → "${answer}"  (was: "${(existing as any).answer}")`);
      updated++;
    } else {
      console.log(`  = "${pattern}" → "${answer}"  (unchanged)`);
      unchanged++;
    }
  }

  console.log(
    `\nSeeded ${Object.keys(CANONICAL_RULES).length} rules: ${inserted} new, ${updated} updated, ${unchanged} unchanged\n`,
  );
  await disconnectDatabase();
}

main().catch((err) => {
  console.error('FATAL:', (err as Error).message);
  process.exit(1);
});
