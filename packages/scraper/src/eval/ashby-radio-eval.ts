import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { chromium } from 'playwright';
import { AppModule } from '../app.module';
import { AshbyFormFillerService } from '../apply/greenhouse/ashby-form-filler.service';
import { connectToDatabase, disconnectDatabase, loadProfile } from '../persistence/db';

// Drives the real AshbyFormFillerService against synthetic forms served through
// page.setContent, covering the radio-group DOM shapes that ATS pages actually
// emit. This lives here rather than in the vitest suite because the logic under
// test runs inside page.evaluate — it needs a real browser, and the answers come
// from the live rules/profile in Mongo, same as the other eval harnesses.
//
// Every case below is a shape that once produced a wrong answer or no answer.

const ashbyOption = (name: string, value: string) =>
  `<div class="_option"><span class="_container"><input type="radio" name="${name}" value="${value}"></span><label>${value}</label></div>`;

interface Case {
  name: string;
  html: string;
  /** Question the walk should derive, or null when the group must be skipped. */
  expectLabel: string | null;
  /** Option that must end up selected. Omit to assert only on the label. */
  expectPick?: string | null;
  /** First option text of the group under test, when a fixture has several. */
  forGroup?: string;
}

const CASES: Case[] = [
  {
    // Ashby's EEO markup: empty <legend>, question in a <label> before the options.
    // The old walk returned on the empty legend, so these never filled.
    name: 'Ashby demographic group (empty legend, question in a sibling label)',
    html: `<fieldset><legend></legend><label>Gender</label><div>Input gender</div>
           ${['Male', 'Female', 'Decline to self-identify'].map((o) => ashbyOption('g', o)).join('')}</fieldset>`,
    expectLabel: 'Gender',
    expectPick: 'Female',
  },
  {
    name: 'Standard fieldset with a real legend',
    html: `<fieldset><legend>Are you legally authorized to work in the US?</legend>
           ${['Yes', 'No'].map((o) => ashbyOption('w', o)).join('')}</fieldset>`,
    expectLabel: 'Are you legally authorized to work in the US?',
    expectPick: 'Yes',
  },
  {
    // A question is allowed to mention its own options; only a wrapper whose text is
    // nothing *but* the options concatenated should be rejected.
    name: 'Question text mentions two of its own options',
    html: `<fieldset><legend>Do you prefer remote or hybrid work?</legend>
           ${['Remote', 'Hybrid'].map((o) => ashbyOption('p', o)).join('')}</fieldset>`,
    expectLabel: 'Do you prefer remote or hybrid work?',
  },
  {
    name: 'Yes/No question whose text contains both "yes" and "no"',
    html: `<fieldset><legend>Yes or No: do you now require sponsorship?</legend>
           ${['Yes', 'No'].map((o) => ashbyOption('s', o)).join('')}</fieldset>`,
    expectLabel: 'Yes or No: do you now require sponsorship?',
  },
  {
    name: 'Wrapper label holding every option concatenated is rejected',
    html: `<fieldset><legend></legend><label>MaleFemaleDecline to self-identify</label>
           <label>Gender</label>${['Male', 'Female', 'Decline to self-identify'].map((o) => ashbyOption('c', o)).join('')}</fieldset>`,
    expectLabel: 'Gender',
  },
  {
    // Radio is a direct child of its own <label>. Reading the wrapping span's next
    // sibling first returns the *next* option's text for every radio but the last.
    name: 'Radio nested directly inside its own label',
    html: `<div class="_fieldEntry"><label>Phone Number</label><input type="text">
           <div class="_legal"><div>Check Yes or No</div><div class="_container">
           <label class="_label"><input type="radio" name="k" value="y">Yes - I consent</label>
           <label class="_label"><input type="radio" name="k" value="n">No - I do not consent</label>
           </div></div></div>`,
    expectLabel: 'Phone Number',
    expectPick: null,
  },
  {
    name: 'Unlabelled group must not steal an adjacent field\'s question',
    html: `<div class="_fieldEntry"><label>Are you legally authorized to work in the US?</label>
           <input type="text" id="auth"></div>
           <div class="_group">${['Yes', 'No'].map((o) => ashbyOption('bleed', o)).join('')}</div>`,
    expectLabel: null,
  },
  {
    // Guards ':scope > legend'. A bare querySelector('legend') walks up to <form>
    // and returns a neighbouring fieldset's legend as this group's question.
    name: 'Empty-legend fieldset must not adopt a neighbouring fieldset\'s legend',
    html: `<fieldset><legend>Do you require sponsorship?</legend>
           ${['Yes', 'No'].map((o) => ashbyOption('q1', o)).join('')}</fieldset>
           <fieldset><legend></legend>${['Male', 'Female'].map((o) => ashbyOption('q2', o)).join('')}</fieldset>`,
    forGroup: 'Male',
    expectLabel: null,
  },
  {
    name: 'Group with no question text anywhere is skipped, not guessed',
    html: `<div>${['Alpha', 'Beta'].map((o) => ashbyOption('nolabel', o)).join('')}</div>`,
    expectLabel: null,
  },
  {
    // Two-way substring matching alone picks "Not applicable to me" for the answer
    // "No", because "not applicable to me".includes("no") is true.
    name: 'Exact option match wins when the answer is a prefix of a longer option',
    html: `<fieldset><legend>Are you a protected veteran?</legend>
           ${['Not applicable to me', 'No', 'Yes'].map((o) => ashbyOption('vet', o)).join('')}</fieldset>`,
    expectLabel: 'Are you a protected veteran?',
    expectPick: 'No',
  },
  {
    name: 'Already-answered group is left untouched',
    html: `<fieldset><legend>Gender</legend>
           <div class="_option"><span class="_container"><input type="radio" name="pre" value="Male" checked></span><label>Male</label></div>
           <div class="_option"><span class="_container"><input type="radio" name="pre" value="Female"></span><label>Female</label></div></fieldset>`,
    expectLabel: null,
    expectPick: 'Male',
  },
];

async function main() {
  await connectToDatabase();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const filler = app.get(AshbyFormFillerService);
  const profile = await loadProfile();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();

  console.log(`\n  Ashby radio-group eval — ${CASES.length} cases\n`);
  let failures = 0;

  for (const c of CASES) {
    await page.setContent(`<html><body><form>${c.html}</form></body></html>`);

    // The filler reports everything through console.log; capture it rather than
    // reaching into internals, so the eval tests the same surface phase4 sees.
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    await filler
      .fillAshbyForm(page, { id: '__eval__', title: 'Software Engineer', company: 'Eval', url: 'about:blank' } as any, profile, () => null)
      .catch((err) => logs.push(`THREW ${(err as Error).message}`));
    console.log = realLog;

    const radioLines = logs.filter((l) => l.includes('Radio "'));
    const line =
      (c.forGroup
        ? radioLines.find((l) => l.split(': ').slice(1).join(': ').startsWith(c.forGroup!))
        : radioLines[0]) || '';
    const gotLabel = (line.match(/Radio "([^"]*)"/) || [])[1] ?? null;
    const gotPick = await page
      .$eval(
        'input[type=radio]:checked',
        (el: any) => (el.closest('label') || el.parentElement?.nextElementSibling)?.textContent?.trim() || el.value,
      )
      .catch(() => null);

    const labelOk = gotLabel === c.expectLabel;
    const pickOk = c.expectPick === undefined || gotPick === c.expectPick;
    if (labelOk && pickOk) {
      console.log(`  ✓ ${c.name}`);
      continue;
    }
    failures++;
    console.log(`  ✗ ${c.name}`);
    if (!labelOk) console.log(`      label:  got ${JSON.stringify(gotLabel)}  want ${JSON.stringify(c.expectLabel)}`);
    if (!pickOk) console.log(`      picked: got ${JSON.stringify(gotPick)}  want ${JSON.stringify(c.expectPick)}`);
    const note = logs.find((l) => /Skipped radio|walk failed|no option matched|THREW/.test(l));
    if (note) console.log(`      note:   ${note.trim()}`);
  }

  console.log(`\n  ${CASES.length - failures}/${CASES.length} passed\n`);
  await browser.close();
  await app.close();
  await disconnectDatabase();
  process.exit(failures === 0 ? 0 : 1);
}

main();
