import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

import { connectToDatabase, disconnectDatabase } from '../persistence/db';
import { UserModel, ProfileAnswerModel } from '@job-agent/shared';

const DEMOGRAPHICS = {
  race: 'Asian',
  hispanic_or_latino: false,
  gender: 'Female',
  pronouns: 'She/Her',
  disability: false,
  veteran: false,
  transgender: false,
  sexual_orientation: 'Heterosexual/Straight',
  citizen_or_permanent_resident: false,
};

const DEMOGRAPHIC_RULES: Record<string, string> = {
  race: 'Asian',
  ethnicity: 'Asian',
  'ethnic background': 'Asian',
  'racial identity': 'Asian',
  'hispanic or latino': 'No',
  latinx: 'No',
  gender: 'Female',
  pronouns: 'She/Her',
  'preferred pronouns': 'She/Her',
  disability: 'No',
  'have a disability': 'No',
  veteran: 'No',
  'military service': 'No',
  'protected veteran': 'No',
  transgender: 'No',
  'us citizen': 'No',
  'permanent resident': 'No',
  'authorized to work': 'Yes',
  'legally authorized': 'Yes',
  'legally work': 'Yes',
  'eligible to work': 'Yes',
  'work authorization': 'Yes',
  sponsor: 'No',
  h1b: 'No',
  'h-1b': 'No',
  'employer to sponsor': 'No',
};

async function main() {
  await connectToDatabase();

  // Upsert demographics on the single user document.
  const user = await UserModel.findOne();
  if (!user) {
    console.error('No User document found in DB. Run the profile migration first.');
    process.exit(1);
  }
  (user as any).demographics = { ...(user as any).demographics, ...DEMOGRAPHICS };
  await user.save();
  console.log('Demographics upserted on UserModel:');
  for (const [k, v] of Object.entries(DEMOGRAPHICS)) console.log(`  ${k}: ${v}`);

  // Upsert keyword rules.
  let inserted = 0,
    updated = 0,
    unchanged = 0;
  for (const [pattern, answer] of Object.entries(DEMOGRAPHIC_RULES)) {
    const existing = await ProfileAnswerModel.findOne({ question_pattern: pattern }).lean();
    if (!existing) {
      await ProfileAnswerModel.create({ question_pattern: pattern, answer });
      inserted++;
    } else if ((existing as any).answer !== answer) {
      await ProfileAnswerModel.updateOne({ question_pattern: pattern }, { $set: { answer } });
      updated++;
    } else {
      unchanged++;
    }
  }

  console.log(
    `\nKeyword rules: ${inserted} new, ${updated} updated, ${unchanged} unchanged (${Object.keys(DEMOGRAPHIC_RULES).length} total)`,
  );
  await disconnectDatabase();
}

main().catch((err) => {
  console.error('FATAL:', (err as Error).message);
  process.exit(1);
});
