import { Inject, Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ScoredJob } from '../../types';
import { OptionMatcherService } from '../../answer-resolution/option-matcher.service';
import { DirectAnswerService } from '../../answer-resolution/direct-answer.service';
import { QuestionAnswererService } from '../../answer-resolution/question-answerer.service';
import { isRefusalText } from '../../answer-resolution/refusal';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Runs in the page. Reads one radio's visible option text, trying the markup shapes
// Ashby actually emits in order of reliability.
function readAshbyOptionText(el: Element): string {
  // Standard markup first: a <label for> pointing at the radio, or a <label> wrapping
  // it. Checking Ashby's span trick before these reads the *next* option's text
  // whenever the radio is a direct child of its own label.
  const byFor = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
  if (byFor?.textContent?.trim()) return byFor.textContent.trim();
  const ownLabel = el.closest('label');
  if (ownLabel?.textContent?.trim()) return ownLabel.textContent.trim();
  // Ashby's own markup: the radio is wrapped in a bare <span> and the visible option
  // text is that span's next sibling.
  const parentSpan = el.parentElement;
  const nextSibling = parentSpan?.nextElementSibling;
  if (nextSibling?.textContent?.trim()) return nextSibling.textContent.trim();
  // Only fall back to the wrapper's text when it wraps this radio alone. Otherwise
  // it returns every option in the group concatenated into one string, which then
  // gets fed to the option matcher as if it were a single choice.
  const optionDiv = parentSpan?.parentElement;
  if (optionDiv && optionDiv.querySelectorAll('input[type="radio"]').length === 1) {
    return optionDiv.textContent?.trim() || '';
  }
  return '';
}

@Injectable()
export class AshbyFormFillerService {
  constructor(
    @Inject(OptionMatcherService) private readonly optionMatcher: OptionMatcherService,
    @Inject(DirectAnswerService) private readonly directAnswer: DirectAnswerService,
    @Inject(QuestionAnswererService) private readonly questionAnswerer: QuestionAnswererService,
  ) {}

  async fillAshbyForm(
  page: Page,
  job: ScoredJob,
  profile: any,
  getPreScrapedAnswer: (fieldId: string, label: string) => string | null,
): Promise<void> {
  console.log('  Filling Ashby form...');
  console.log('  [Ashby] Section 1: resume upload');
  // 1. Upload resume FIRST (Ashby re-renders form after upload)
  try {
    const resumeInput = await page.$('input[type="file"][id="_systemfield_resume"]');
    if (resumeInput) {
      const resumeDir = path.join(__dirname, '../../../data/resume');
      try {
        const fsModule = await import('fs');
        const files = fsModule
          .readdirSync(resumeDir)
          .filter((f: string) => f.toLowerCase().endsWith('.pdf'));
        if (files.length > 0) {
          const resumePath = path.join(resumeDir, files[0]);
          const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
            resumeInput.evaluate((el) => (el as HTMLElement).click()),
          ]);
          if (fileChooser) {
            await fileChooser.setFiles(resumePath);
          } else {
            await resumeInput.setInputFiles(resumePath);
          }
          console.log(`    ✓ Uploaded resume: ${files[0]}`);
          await sleep(2000);
        }
      } catch {
        /* skip */
      }
    }
  } catch (err) {
    console.log(`  [Ashby] 1 resume error: ${(err as Error).message.slice(0, 80)}`);
  }

  console.log('  [Ashby] Section 1b: cover letter');
  try {
    // 1b. Upload cover letter if the field exists
    const clInput = await page.$(
      'input[type="file"][id="cover_letter"], input[type="file"][id*="cover"]',
    );
    if (clInput) {
      try {
        const { CoverLetterModel } = await import('../../persistence/db');
        const { ApplicationFieldsModel } = await import('@job-agent/shared');
        let coverLetter = '';
        const preFilled = (await ApplicationFieldsModel.findOne({ externalJobId: job.id })
          .lean()
          .catch(() => null)) as any;
        if (preFilled?.coverLetter) coverLetter = preFilled.coverLetter;
        if (!coverLetter) {
          const clDoc = await CoverLetterModel.findOne({ externalJobId: job.id })
            .sort({ generatedAt: -1 })
            .lean()
            .catch(() => null);
          if ((clDoc as any)?.content) coverLetter = (clDoc as any).content;
        }
        if (coverLetter) {
          const fsModule = await import('fs');
          const tempDir = path.join(__dirname, '../../../data/cover-letters');
          fsModule.mkdirSync(tempDir, { recursive: true });
          // Use .pdf extension — Ashby accepts PDF and the upload handler processes it
          const filename = `${job.company.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-cover-letter.pdf`;
          const filepath = path.join(tempDir, filename);
          fsModule.writeFileSync(filepath, coverLetter);
          // Click the Upload File button in the Cover Letter section
          const clLabel = page.locator('label:has-text("Cover Letter")');
          const clSection = clLabel.locator('..');
          const uploadBtn = clSection.locator('text=Upload File');
          if ((await uploadBtn.count()) > 0) {
            const [fileChooser] = await Promise.all([
              page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
              uploadBtn.first().click(),
            ]);
            if (fileChooser) {
              await fileChooser.setFiles(filepath);
              console.log(`    ✓ Uploaded cover letter (${coverLetter.length} chars)`);
              await sleep(2000);
            }
          } else {
            // Fallback: setInputFiles on the hidden input
            await clInput.setInputFiles(filepath);
            console.log(`    ✓ Cover letter set via input (${coverLetter.length} chars)`);
            await sleep(1000);
          }
        }
      } catch (err) {
        console.log(`    ○ Cover letter failed: ${(err as Error).message.slice(0, 50)}`);
      }
    }
  } catch (err) {
    console.log(`  [Ashby] 1b cover letter error: ${(err as Error).message.slice(0, 80)}`);
  }

  console.log('  [Ashby] Section 2: text inputs');
  // 2. Fill all text/email/tel inputs
  try {
    const allInputs = await page.$$(
      'input[type="text"], input[type="email"], input[type="tel"], input[type="url"]',
    );
    for (const inp of allInputs) {
      try {
        const isHidden = await inp.isHidden().catch(() => true);
        if (isHidden) continue;

        const id = (await inp.getAttribute('id').catch(() => '')) || '';
        const inputType = (await inp.getAttribute('type').catch(() => '')) || '';
        const placeholder = (
          (await inp.getAttribute('placeholder').catch(() => '')) || ''
        ).toLowerCase();
        const label = await inp
          .evaluate((el) => {
            const wrapper = el.closest('[class*="field"], [class*="Field"]');
            const labelEl = wrapper?.querySelector('label');
            return labelEl?.textContent?.trim() || '';
          })
          .catch(() => '');
        const hint = (placeholder + ' ' + label).toLowerCase();

        const existing = await inp.inputValue().catch(() => '');
        if (existing) continue;

        let value = '';
        if (id === '_systemfield_name') value = profile?.personal?.name || '';
        else if (id === '_systemfield_email') value = profile?.personal?.email || '';
        else if (inputType === 'tel' || hint.includes('phone'))
          value = profile?.personal?.phone || '';
        else if (hint.includes('linkedin')) value = profile?.personal?.linkedin || '';
        else if (hint.includes('github')) value = profile?.personal?.github || '';
        else if (hint.includes('website') || hint.includes('portfolio')) value = '';
        else if (
          hint.includes('location') ||
          hint.includes('city') ||
          hint.includes('address') ||
          hint.includes('where') ||
          hint.includes('work from') ||
          hint.includes('working from') ||
          hint.includes('payroll')
        )
          value = (
            profile?.preferences?.location?.current_city ||
            profile?.personal?.location ||
            ''
          ).replace(/, USA$/, '');
        else {
          // Try pre-scraped or rules
          const preAnswer = getPreScrapedAnswer(id, label || placeholder);
          if (preAnswer) value = preAnswer;
          if (!value) {
            const directAnswer = this.directAnswer.getDirectAnswer(id, label || placeholder, profile);
            if (directAnswer) value = directAnswer;
          }
        }

        if (value) {
          await inp.scrollIntoViewIfNeeded().catch(() => {});
          await inp.click({ timeout: 3000 }).catch(async () => {
            await inp.focus().catch(() => {});
          });
          await inp.fill('').catch(() => {});
          await inp.type(value, { delay: 5 }).catch(async () => {
            await inp.fill(value).catch(() => {});
          });
          await sleep(100);
          console.log(`    ✓ Filled: "${label || id}" = "${value.slice(0, 40)}"`);
        }
      } catch (err) {
        console.log(`    ○ Text input error: ${(err as Error).message.slice(0, 60)}`);
      }
    }
  } catch (err) {
    console.log(`  [Ashby] 2 text input error: ${(err as Error).message.slice(0, 80)}`);
  }

  console.log('  [Ashby] Section 2b: native selects');
  // 2b. Handle native <select> dropdowns
  try {
    const selects = await page.$$('select');
    for (const sel of selects) {
      const isHidden = await sel.isHidden().catch(() => true);
      if (isHidden) continue;
      const currentVal = await sel
        .$eval('option:checked', (o: Element) => (o as HTMLOptionElement).value)
        .catch(() => '');
      if (currentVal) continue;

      const label = await sel
        .evaluate((el) => {
          const wrapper = el.closest('[class*="field"], [class*="Field"]');
          const labelEl = wrapper?.querySelector('label');
          return labelEl?.textContent?.trim() || '';
        })
        .catch(() => '');
      if (!label) continue;

      const options = await sel.$$eval('option:not([value=""])', (opts: Element[]) =>
        opts.map((o) => (o as HTMLOptionElement).text.trim()),
      );

      // Get answer from profile
      const answer = this.directAnswer.getDirectAnswer('', label, profile, 'select');
      if (answer) {
        const matched = this.optionMatcher.smartMatchOption(answer, options, label);
        if (matched) {
          await sel.selectOption({ label: matched });
          console.log(`    ✓ Select: "${label}" → "${matched}"`);
          continue;
        }
      }
      // Try pre-scraped
      const preAnswer = getPreScrapedAnswer('', label);
      if (preAnswer) {
        const matched = this.optionMatcher.smartMatchOption(preAnswer, options, label);
        if (matched) {
          await sel.selectOption({ label: matched });
          console.log(`    ✓ Select (pre-scraped): "${label}" → "${matched}"`);
          continue;
        }
      }
      console.log(`    ○ Select empty: "${label}" [${options.join(', ')}]`);
    }
  } catch (err) {
    console.log(`  [Ashby] 2b select error: ${(err as Error).message.slice(0, 80)}`);
  }

  console.log('  [Ashby] Section 2c: comboboxes');
  // 2c. Handle combobox/React Select dropdowns
  try {
    const comboboxes = await page.$$('input[role="combobox"]');
    for (const combo of comboboxes) {
      const isHidden = await combo.isHidden().catch(() => true);
      if (isHidden) continue;
      const id = (await combo.getAttribute('id').catch(() => '')) || '';

      // Check if already has value
      const hasValue = await combo
        .evaluate((el) => {
          const container = el.closest('[class*="select"]');
          const sv = container?.querySelector('[class*="singleValue"], [class*="single-value"]');
          return sv?.textContent?.trim() || '';
        })
        .catch(() => '');
      if (hasValue) continue;

      const label = await combo
        .evaluate((el) => {
          const wrapper = el.closest('[class*="field"], [class*="Field"]');
          const labelEl = wrapper?.querySelector('label');
          return labelEl?.textContent?.trim() || '';
        })
        .catch(() => '');
      if (!label) continue;

      // Get answer
      let answer = getPreScrapedAnswer(id, label);
      if (!answer) answer = this.directAnswer.getDirectAnswer(id, label, profile, 'select');
      if (!answer) continue;

      console.log(`    Combobox "${label}": answer="${answer}"`);

      // Type answer to filter, then click match
      await combo.click({ timeout: 3000 }).catch(() => {});
      await sleep(300);
      await combo.fill('');
      await combo.type(answer, { delay: 5 });
      await sleep(500);

      // Click matching option from scoped menu
      const menuId = (await combo.getAttribute('aria-controls').catch(() => '')) || '';
      let clicked = false;
      if (menuId) {
        const opts = page.locator(`#${menuId} [class*="option"]`);
        const count = await opts.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const text = (
            (await opts
              .nth(i)
              .textContent()
              .catch(() => '')) || ''
          ).trim();
          if (
            text.toLowerCase() === answer.toLowerCase() ||
            text.toLowerCase().includes(answer.toLowerCase()) ||
            answer.toLowerCase().includes(text.toLowerCase())
          ) {
            await opts.nth(i).click({ timeout: 3000 });
            console.log(`    ✓ Combobox: "${label}" → "${text}"`);
            clicked = true;
            break;
          }
        }
      }
      if (!clicked) {
        await page.keyboard.press('Enter');
        await sleep(200);
        const newVal = await combo
          .evaluate((el) => {
            const c = el.closest('[class*="select"]');
            const v = c?.querySelector('[class*="singleValue"]');
            return v?.textContent?.trim() || '';
          })
          .catch(() => '');
        if (newVal) {
          console.log(`    ✓ Combobox: "${label}" → "${newVal}" (Enter)`);
        } else {
          await page.keyboard.press('Escape').catch(() => {});
          console.log(`    ○ Combobox: "${label}" — couldn't select "${answer}"`);
        }
      }
    }
  } catch (err) {
    console.log(`  [Ashby] 2c combobox error: ${(err as Error).message.slice(0, 80)}`);
  }

  console.log('  [Ashby] Section 2d0: yes/no button groups');
  // 2d0. Handle Ashby custom Yes/No question (rendered as <button> pair, not checkbox/radio)
  try {
    const yesNoContainers = await page.$$('[class*="yesno"]');
    for (const container of yesNoContainers) {
      try {
        // Find question label — walk up to the field entry wrapper
        const label = await container
          .evaluate((el) => {
            let node: Element | null = el;
            for (let i = 0; i < 6 && node; i++) {
              const wrapperLabel = node.querySelector('label');
              if (wrapperLabel && !wrapperLabel.contains(el)) {
                return (wrapperLabel.textContent || '').trim();
              }
              node = node.parentElement;
            }
            return '';
          })
          .catch(() => '');
        if (!label) continue;

        // Check if already answered (a button has class containing "selected" / "checked" / aria-pressed)
        const already = await container
          .evaluate((el) => {
            const btns = el.querySelectorAll('button');
            for (const b of Array.from(btns)) {
              const cls = b.className || '';
              if (/selected|checked|active/i.test(cls)) return true;
              if (b.getAttribute('aria-pressed') === 'true') return true;
            }
            const cb = el.querySelector('input[type="checkbox"]');
            return !!(cb && (cb as HTMLInputElement).checked);
          })
          .catch(() => false);
        if (already) continue;

        let answer = getPreScrapedAnswer('', label);
        if (!answer) answer = this.directAnswer.getDirectAnswer('', label, profile, 'select');
        if (!answer) continue;

        const want = answer.toLowerCase().startsWith('y')
          ? 'Yes'
          : answer.toLowerCase().startsWith('n')
            ? 'No'
            : '';
        if (!want) continue;
        const btn = await container.$(`button:has-text("${want}")`);
        if (!btn) continue;
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        const clicked = await btn
          .click({ timeout: 2000 })
          .then(() => true)
          .catch(() => false);
        if (!clicked) {
          await btn.evaluate((b) => (b as HTMLButtonElement).click()).catch(() => {});
        }
        console.log(`    ✓ Yes/No: "${label.slice(0, 60)}" → "${want}"`);
        await sleep(200);
      } catch {
        /* next container */
      }
    }
  } catch (err) {
    console.log(`  [Ashby] 2d0 yes/no error: ${(err as Error).message.slice(0, 80)}`);
  }

  console.log('  [Ashby] Section 2d: checkboxes');
  // 2d. Handle checkboxes (multi-select questions)
  try {
    const checkboxGroups = await page.$$('[class*="field"], [class*="Field"]');
    for (const group of checkboxGroups) {
      try {
        const checkboxes = await group.$$('input[type="checkbox"]');
        if (checkboxes.length === 0) continue;

        const checked = await group.$('input[type="checkbox"]:checked');
        if (checked) continue;

        const label = await group
          .evaluate((el) => {
            const labelEl = el.querySelector('label');
            return labelEl?.textContent?.trim() || '';
          })
          .catch(() => '');
        if (!label) continue;

        const answer = this.directAnswer.getDirectAnswer('', label, profile, 'select');
        if (!answer) continue;

        // Click matching checkbox option
        for (const cb of checkboxes) {
          try {
            const cbLabel = await cb
              .evaluate((el) => {
                const input = el as HTMLInputElement;
                // 1. <label for={id}>
                if (input.id) {
                  const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
                  if (l && l.textContent) return l.textContent.trim();
                }
                // 2. aria-label on input
                const aria = input.getAttribute('aria-label');
                if (aria) return aria.trim();
                // 3. closest <label>
                const wrappingLabel = input.closest('label');
                if (wrappingLabel && wrappingLabel.textContent)
                  return wrappingLabel.textContent.trim();
                // 4. immediate next sibling that's a label/span
                const sib = input.nextElementSibling;
                if (sib && (sib.tagName === 'LABEL' || sib.tagName === 'SPAN') && sib.textContent) {
                  return sib.textContent.trim();
                }
                // 5. parent's own text (without merging sibling rows)
                const parent = input.parentElement;
                if (parent) {
                  const directText = Array.from(parent.childNodes)
                    .filter(
                      (n) =>
                        n.nodeType === Node.TEXT_NODE ||
                        (n as Element).tagName === 'SPAN' ||
                        (n as Element).tagName === 'LABEL',
                    )
                    .map((n) => n.textContent || '')
                    .join(' ')
                    .trim();
                  if (directText) return directText;
                }
                return '';
              })
              .catch(() => '');
            const a = answer.toLowerCase().trim();
            const l = cbLabel.toLowerCase().trim();
            if (!l) continue;
            // Exact match or answer equals label; avoid "yes" matching "yesno" by requiring word-boundary match
            const matched =
              l === a ||
              (l.length <= 6 && a.length <= 6 && (l.startsWith(a) || a.startsWith(l))) ||
              new RegExp(`\\b${a.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`).test(l);
            if (!matched) continue;
            // Click the associated label if the input is hidden (common for custom checkboxes)
            await cb.scrollIntoViewIfNeeded().catch(() => {});
            const clicked = await cb
              .click({ force: true, timeout: 2000 })
              .then(() => true)
              .catch(() => false);
            if (!clicked) {
              // Fallback: click the parent label wrapper
              const clickedLabel = await cb
                .evaluate((el) => {
                  const lbl = (el as HTMLElement).closest('label');
                  if (lbl) {
                    (lbl as HTMLElement).click();
                    return true;
                  }
                  const parent = (el as HTMLElement).parentElement;
                  if (parent) {
                    parent.click();
                    return true;
                  }
                  return false;
                })
                .catch(() => false);
              if (!clickedLabel) continue;
            }
            console.log(`    ✓ Checkbox: "${label}" → "${cbLabel}"`);
          } catch {
            /* next checkbox */
          }
        }
      } catch {
        /* next group */
      }
    }
  } catch (err) {
    console.log(`  [Ashby] 2d checkbox error: ${(err as Error).message.slice(0, 80)}`);
  }

  console.log('  [Ashby] Section 3: radios');
  try {
    // 3. Handle radio groups
    const radioInputs = await page.$$('input[type="radio"]');
    if (radioInputs.length > 0) {
      const radioNames = new Set<string>();
      for (const r of radioInputs) {
        const name = (await r.getAttribute('name').catch(() => '')) || '';
        if (name) radioNames.add(name);
      }

      for (const name of radioNames) {
        const checked = await page.$(`input[type="radio"][name="${name}"]:checked`);
        if (checked) continue;

        // Read the options BEFORE deriving the question. Ashby renders each radio
        // group in a <fieldset> with an *empty* <legend>, so walking up for a label
        // lands on the first option ("Male", "Hispanic or Latino") and the group
        // gets answered as though that were the question. Knowing the option texts
        // up front lets the walk reject any candidate that is really an option.
        const radios = await page.$$(`input[type="radio"][name="${name}"]`);
        const options: { radio: (typeof radios)[number]; text: string }[] = [];
        for (const radio of radios) {
          const text = await radio.evaluate(readAshbyOptionText).catch(() => '');
          if (text) options.push({ radio, text });
        }
        if (!options.length) continue;
        const optionTexts = options.map((o) => o.text);

        const groupLabel = await options[0].radio
          .evaluate((el, opts: string[]) => {
            // No named helper functions inside this callback: esbuild's keepNames
            // rewrites both function declarations and named arrows into a __name()
            // call that does not exist in the page, which throws ReferenceError.
            // Only anonymous inline arrows survive the trip.
            const normalized = opts
              .map((o) => (o || '').replace(/\s+/g, ' ').trim().toLowerCase())
              .filter(Boolean);

            // Collect label candidates innermost-first, then pick the first that
            // isn't itself an option.
            const candidates: (Element | null)[] = [];
            let node: Element | null = el;
            for (let i = 0; i < 10 && node; i++) {
              node = node.parentElement;
              if (!node) break;
              candidates.push(node.querySelector('legend'));
              for (const label of Array.from(node.querySelectorAll(':scope > label'))) {
                if (!label.querySelector('input')) candidates.push(label);
              }
              // Ashby puts the real question ("Gender", "Race") in a <label> that is
              // a sibling *before* the group's wrapper, not inside it.
              let sib = node.previousElementSibling;
              for (let j = 0; j < 3 && sib; j++) {
                candidates.push(sib.matches('label, legend') ? sib : sib.querySelector('label, legend'));
                sib = sib.previousElementSibling;
              }
            }

            for (const candidate of candidates) {
              const t = candidate?.textContent?.replace(/\s+/g, ' ').trim() || '';
              if (!t || t.length >= 200) continue;
              const n = t.toLowerCase();
              if (normalized.includes(n)) continue; // it's an option label, not the question
              // A wrapper's text is every option concatenated — also not the question.
              if (normalized.filter((o) => n.includes(o)).length >= 2) continue;
              return t;
            }
            return '';
          }, optionTexts)
          .catch((e: Error) => {
            // A silently-swallowed failure here is indistinguishable from "no label
            // found", which is how the demographic groups went unfilled unnoticed.
            console.log(`    ○ Radio label walk failed: ${e.message.slice(0, 100)}`);
            return '';
          });
        if (!groupLabel) {
          console.log(`    ○ Skipped radios (no question text): ${optionTexts.slice(0, 3).join(' | ')}`);
          continue;
        }

        console.log(`    Radio "${groupLabel}": ${optionTexts.join(' | ')}`);

        // Same resolution order as the Greenhouse filler: pre-scraped answer from
        // the Prepare tab, then saved rules, then the hardcoded profile answer.
        let answer = '';
        const preAnswer = getPreScrapedAnswer('', groupLabel);
        if (preAnswer && !isRefusalText(preAnswer)) {
          answer = this.optionMatcher.smartMatchOption(preAnswer, optionTexts, groupLabel) || '';
        }
        if (!answer) {
          try {
            const ruleAnswer = await this.questionAnswerer.answerQuestion(
              groupLabel,
              'radio',
              optionTexts,
            );
            if (ruleAnswer && !isRefusalText(ruleAnswer)) {
              answer = this.optionMatcher.smartMatchOption(ruleAnswer, optionTexts, groupLabel) || '';
            }
          } catch {
            /* fall through to the profile answer */
          }
        }
        if (!answer) {
          const direct = this.directAnswer.getDirectAnswer('', groupLabel, profile, 'radio');
          if (direct) {
            answer = this.optionMatcher.smartMatchOption(direct, optionTexts, groupLabel) || '';
          }
        }

        // Last resort for work-location questions, which are phrased too many ways
        // for the rules to cover and always want the remote/hybrid option.
        if (!answer) {
          const gl = groupLabel.toLowerCase();
          const hasLocationOptions = optionTexts.some((o) => /remote|hybrid|nyc|office|relocat/i.test(o));
          if (/work|location|remote|office|where/.test(gl) || hasLocationOptions) {
            answer =
              optionTexts.find((o) => /remote/i.test(o)) ||
              optionTexts.find((o) => /hybrid/i.test(o)) ||
              optionTexts.find((o) => /relocat/i.test(o)) ||
              optionTexts[0];
          }
        }

        if (!answer) {
          console.log(`    ○ Skipped radio: "${groupLabel}" — fill manually`);
          continue;
        }

        // Exact option text first. Two-way substring matching alone picks the wrong
        // radio whenever options overlap — "female".includes("male") is true.
        const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        const target =
          options.find((o) => norm(o.text) === norm(answer)) ||
          options.find((o) => norm(o.text).includes(norm(answer)) || norm(answer).includes(norm(o.text)));
        if (!target) {
          console.log(`    ○ Radio "${groupLabel}": no option matched "${answer}"`);
          continue;
        }
        await target.radio.click({ force: true });
        console.log(`    ✓ Radio: "${groupLabel}" → "${target.text}"`);
      }
    }
  } catch (err) {
    console.log(`  [Ashby] 3 radio error: ${(err as Error).message.slice(0, 80)}`);
  }

  console.log('  [Ashby] Section 4: textareas');
  try {
    // 4. Fill textareas
    const textareas = await page.$$('textarea');
    for (const ta of textareas) {
      const isHidden = await ta.isHidden().catch(() => true);
      if (isHidden) continue;
      const existing = await ta.inputValue().catch(() => '');
      if (existing) continue;
      const label = await ta
        .evaluate((el) => {
          const wrapper = el.closest('[class*="field"], [class*="Field"]');
          const labelEl = wrapper?.querySelector('label');
          return labelEl?.textContent?.trim() || '';
        })
        .catch(() => '');
      if (!label) continue;
      // Try pre-scraped or rules
      const preAnswer = getPreScrapedAnswer('', label);
      if (preAnswer) {
        await ta.click({ force: true }).catch(() => {});
        await ta.fill(preAnswer);
        console.log(`    ✓ Textarea: "${label}"`);
      }
    }
  } catch (err) {
    console.log(`  [Ashby] 4 textarea error: ${(err as Error).message.slice(0, 80)}`);
  }

  console.log('  Ashby form fill complete.');
}

}
