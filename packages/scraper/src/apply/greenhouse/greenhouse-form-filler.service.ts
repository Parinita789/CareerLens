import { Inject, Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ScoredJob } from '../../types';
import { OptionMatcherService } from '../../answer-resolution/option-matcher.service';
import { FieldAnswerResolverService } from '../../answer-resolution/field-answer-resolver.service';
import { isRefusalText } from '../../answer-resolution/refusal';
import { DirectAnswerService } from '../../answer-resolution/direct-answer.service';
import { logQuestionAnswer } from '../../persistence/db';
import { GreenhouseFieldInspectorService } from './greenhouse-field-inspector.service';
import { AshbyFormFillerService } from './ashby-form-filler.service';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class GreenhouseFormFillerService {
  constructor(
    @Inject(OptionMatcherService) private readonly optionMatcher: OptionMatcherService,
    @Inject(FieldAnswerResolverService) private readonly fieldAnswers: FieldAnswerResolverService,
    @Inject(DirectAnswerService) private readonly directAnswer: DirectAnswerService,
    @Inject(GreenhouseFieldInspectorService) private readonly fieldInspector: GreenhouseFieldInspectorService,
    @Inject(AshbyFormFillerService) private readonly ashbyFormFiller: AshbyFormFillerService,
  ) {}

  async fillFormFields(page: Page, job: ScoredJob): Promise<void> {
  // Load profile for direct field mapping
  const { loadProfile } = await import('../../persistence/db');
  const profile = await loadProfile();

  // Load pre-scraped answers (from Prepare tab) — use these first, skip LLM calls
  const { ApplicationFieldsModel } = await import('@job-agent/shared');
  const preScraped = (await ApplicationFieldsModel.findOne({ externalJobId: job.id })
    .lean()
    .catch(() => null)) as any;
  const answerCache = this.fieldAnswers.newCache();
  const preAnswersByFieldId = new Map<string, { value: string; source: string }>();
  const preAnswersByLabel = new Map<string, { value: string; source: string }>();
  let skippedRefusals = 0;
  if (preScraped?.fields) {
    for (const f of preScraped.fields) {
      if (f.value && f.source !== 'unknown') {
        if (isRefusalText(f.value)) {
          skippedRefusals++;
          continue;
        }
        if (f.fieldId) preAnswersByFieldId.set(f.fieldId, { value: f.value, source: f.source });
        preAnswersByLabel.set(f.label.toLowerCase().trim(), { value: f.value, source: f.source });
      }
    }
    console.log(
      `  Pre-scraped answers loaded: ${preAnswersByFieldId.size + preAnswersByLabel.size} answers available${skippedRefusals ? ` (${skippedRefusals} refusals filtered)` : ''}`,
    );
  }

  // Helper: look up pre-scraped answer by fieldId or label (with fuzzy fallback)
  function getPreScrapedAnswer(fieldId: string, label: string): string | null {
    const pick = (v: string | undefined | null): string | null => {
      if (!v) return null;
      if (isRefusalText(v)) return null;
      return v;
    };
    // 1. Exact fieldId match
    if (fieldId) {
      const byId = preAnswersByFieldId.get(fieldId);
      const v = pick(byId?.value);
      if (v) return v;
    }
    // 2. Exact label match
    const normalizedLabel = label.toLowerCase().trim();
    const byLabel = preAnswersByLabel.get(normalizedLabel);
    const v2 = pick(byLabel?.value);
    if (v2) return v2;
    // 3. Fuzzy label match — handles typos, extra words, "in in" vs "in"
    const stripped = normalizedLabel
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    for (const [key, entry] of preAnswersByLabel) {
      const keyStripped = key
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (keyStripped === stripped) {
        const v = pick(entry.value);
        if (v) return v;
      }
      // Substring match for long labels (>20 chars)
      if (stripped.length > 20 && keyStripped.length > 20) {
        if (keyStripped.includes(stripped) || stripped.includes(keyStripped)) {
          const v = pick(entry.value);
          if (v) return v;
        }
      }
    }
    return null;
  }

  // Track filled field IDs to avoid re-processing
  const filledIds = new Set<string>();

  // ── Ashby jobs: use dedicated handler and return (skip all Greenhouse handlers) ──
  if (job.source === 'ashby') {
    await this.ashbyFormFiller.fillAshbyForm(page, job, profile, getPreScrapedAnswer);
    return;
  }

  // Scroll through entire form to ensure all lazy-loaded fields are in DOM
  await page
    .evaluate(
      `(() => {
    const scrollStep = async () => {
      const height = document.body.scrollHeight;
      for (let y = 0; y < height; y += 300) {
        window.scrollTo(0, y);
      }
      window.scrollTo(0, height);
    };
    scrollStep();
  })()`,
    )
    .catch(() => {});
  await sleep(1000);
  await page.evaluate(`(() => { window.scrollTo(0, 0); })()`).catch(() => {});
  await sleep(300);

  // ── Handle React Select / custom dropdowns first ──
  // Run twice: first pass fills visible fields, second pass catches fields that were below the fold
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      // Scroll to bottom again before second pass
      await page
        .evaluate(`(() => { window.scrollTo(0, document.body.scrollHeight); })()`)
        .catch(() => {});
      await sleep(500);
      await page.evaluate(`(() => { window.scrollTo(0, 0); })()`).catch(() => {});
      await sleep(300);
    }
    try {
      const comboboxInputs = await page.$$('input[role="combobox"]');
      if (pass === 0) console.log(`  Found ${comboboxInputs.length} combobox inputs`);
      for (const combo of comboboxInputs) {
        const id = (await combo.getAttribute('id').catch(() => '')) || '';

        // Skip phone country code picker (iti = international telephone input)
        if (id.includes('iti') || id.includes('search-input') || id.includes('country-listbox')) {
          filledIds.add(id);
          continue;
        }

        // CRITICAL: skip already-filled fields (fixes duplicate filling across passes)
        if (id && filledIds.has(id)) continue;

        const label = await this.fieldInspector.getFieldLabel(combo, page);
        if (!label || this.directAnswer.isSkippableLabel(label)) {
          continue;
        }
        console.log(`    Combobox id="${id}" label="${label.slice(0, 60)}"`);

        // Check if already has a value selected (Greenhouse React Select uses select__control/select-shell)
        const selectedValue = await combo
          .evaluate((el) => {
            const shell = el.closest(
              '[class*="select-shell"], [class*="select__container"], [class*="select__control"]',
            );
            if (!shell) return '';
            // Greenhouse marks filled value containers with --has-value modifier
            const filledContainer = shell.querySelector(
              '[class*="value-container"][class*="has-value"], [class*="value-container--has-value"]',
            );
            if (filledContainer) {
              const sv = filledContainer.querySelector(
                '[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"]',
              );
              if (sv) return sv.textContent?.trim() || '';
              const text = filledContainer.textContent?.trim() || '';
              if (text) return text;
            }
            // Fallback: check for single-value div anywhere in shell
            const singleValue = shell.querySelector(
              '[class*="single-value"], [class*="singleValue"]',
            );
            if (singleValue) return singleValue.textContent?.trim() || '';
            return '';
          })
          .catch(() => '');

        if (selectedValue) {
          console.log(`    Dropdown already set: "${label}" = "${selectedValue}"`);
          filledIds.add(id);
          continue;
        }

        // No options to choose from here, so the model is not consulted.
        const resolved = await this.fieldAnswers.resolve({
          fieldId: id,
          label,
          type: 'select',
          profile,
          getPreScrapedAnswer,
          cache: answerCache,
        });
        const answer = resolved?.value ?? '';

        if (!answer) {
          console.log(`    ○ Skipped dropdown: "${label}" — no answer available`);
          continue;
        }

        console.log(`    Dropdown "${label}": answer="${answer}"`);

        // Select from dropdown using type-to-filter approach (scoped to THIS combobox)
        try {
          // Focus and clear the combobox, then type the answer to filter
          await combo.click({ timeout: 5000 });
          await sleep(300);
          await combo.fill('');
          await combo.type(answer, { delay: 15 });
          await sleep(500);

          // Find the CLOSEST menu to this combobox (not the phone picker's menu)
          // Use the combobox's aria-controls or the menu that appeared right after this input
          const menuId = (await combo.getAttribute('aria-controls').catch(() => '')) || '';
          let clicked = false;

          // Detects the React-Select "no matches" placeholder so we don't click it.
          const isPlaceholder = (t: string) =>
            /^(no options?|no results?|nothing found|loading)/i.test((t || '').trim());

          const tryScopedMatch = async (
            id: string,
          ): Promise<{ clicked: boolean; count: number }> => {
            const scoped = page.locator(`#${id} [class*="option"], #${id} [role="option"]`);
            const cnt = await scoped.count().catch(() => 0);
            const texts: string[] = [];
            for (let i = 0; i < cnt; i++) {
              const t = (
                (await scoped
                  .nth(i)
                  .textContent()
                  .catch(() => '')) || ''
              ).trim();
              texts.push(t);
            }
            const realCount = texts.filter((t) => t && !isPlaceholder(t)).length;
            console.log(`    Scoped menu #${id}: ${cnt} options (${realCount} real)`);
            // Pass 1: smart match by alias/semantics
            const smart = this.optionMatcher.smartMatchOption(
              answer,
              texts.filter((t) => !isPlaceholder(t)),
              label,
            );
            if (smart) {
              const idx = texts.indexOf(smart);
              if (idx >= 0) {
                await scoped.nth(idx).click({ timeout: 3000 });
                console.log(`    ✓ Dropdown: "${label}" → "${smart}" (scoped/smart)`);
                return { clicked: true, count: realCount };
              }
            }
            // Pass 2: substring match (ignoring placeholders)
            for (let i = 0; i < cnt; i++) {
              const text = texts[i];
              if (!text || isPlaceholder(text)) continue;
              if (
                text.toLowerCase() === answer.toLowerCase() ||
                text.toLowerCase().includes(answer.toLowerCase()) ||
                answer.toLowerCase().includes(text.toLowerCase())
              ) {
                await scoped.nth(i).click({ timeout: 3000 });
                console.log(`    ✓ Dropdown: "${label}" → "${text}" (scoped)`);
                return { clicked: true, count: realCount };
              }
            }
            // Pass 3: if filter narrowed to a single real option, trust it
            if (realCount === 1) {
              const idx = texts.findIndex((t) => t && !isPlaceholder(t));
              if (idx >= 0 && !/\+\d{1,3}$/.test(texts[idx])) {
                await scoped.nth(idx).click({ timeout: 3000 });
                console.log(`    ✓ Dropdown: "${label}" → "${texts[idx]}" (scoped/only-option)`);
                return { clicked: true, count: realCount };
              }
            }
            return { clicked: false, count: realCount };
          };

          if (menuId) {
            let result = await tryScopedMatch(menuId);
            clicked = result.clicked;
            // If the filter hid all options (0 real), clear filter and retry with full list
            if (!clicked && result.count === 0) {
              // Close menu, clear the input, reopen
              await page.keyboard.press('Escape').catch(() => {});
              await sleep(200);
              await combo.click({ timeout: 2000 }).catch(() => {});
              await sleep(200);
              // Clear any lingering filter via keyboard (React Select can be finicky with fill())
              await combo.press('Control+A').catch(() => {});
              await combo.press('Delete').catch(() => {});
              await sleep(400);
              result = await tryScopedMatch(menuId);
              clicked = result.clicked;
            }
          }

          // Fallback: use the menu that's nearest sibling to this combobox's container
          if (!clicked) {
            // The React Select menu is usually rendered as a sibling of the select container
            const menuLocator = page
              .locator('[class*="select__menu"]:visible, [class*="menu-list"]:visible')
              .last();
            const menuVisible = await menuLocator.isVisible().catch(() => false);
            if (menuVisible) {
              const opts = menuLocator.locator('[class*="option"], [role="option"]');
              const count = await opts.count().catch(() => 0);
              console.log(`    Visible menu: ${count} options`);
              // Check first option — if it's a phone code, skip
              if (count > 0) {
                const firstText = (
                  (await opts
                    .first()
                    .textContent()
                    .catch(() => '')) || ''
                ).trim();
                if (/\+\d{1,3}$/.test(firstText)) {
                  console.log(`    ○ Skipped phone code picker: "${label}"`);
                  await page.keyboard.press('Escape').catch(() => {});
                  filledIds.add(id);
                  continue;
                }
              }
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
                  console.log(`    ✓ Dropdown: "${label}" → "${text}" (visible menu)`);
                  clicked = true;
                  break;
                }
              }
            }
          }

          // Last resort: just press Enter on the first filtered result
          if (!clicked) {
            await page.keyboard.press('Enter');
            await sleep(200);
            // Check if a value was selected
            const newVal = await combo
              .evaluate((el) => {
                const container = el.closest('[class*="select"]');
                const val = container?.querySelector(
                  '[class*="singleValue"], [class*="single-value"]',
                );
                return val?.textContent?.trim() || '';
              })
              .catch(() => '');
            if (newVal) {
              console.log(`    ✓ Dropdown: "${label}" → "${newVal}" (Enter key)`);
              clicked = true;
            }
          }

          if (clicked) {
            filledIds.add(id);
          } else {
            await page.keyboard.press('Escape').catch(() => {});
            console.log(`    ○ Dropdown: "${label}" — couldn't select "${answer}", fill manually`);
          }
        } catch (err) {
          console.log(`    ○ Dropdown failed: "${label}" — ${(err as Error).message.slice(0, 60)}`);
          await page.keyboard.press('Escape').catch(() => {});
        }
        await sleep(100);
      }
    } catch (err) {
      console.log(`  ⚠ Dropdown handler error (continuing): ${(err as Error).message}`);
    }
  } // end combobox two-pass loop

  // ── Fill any remaining unfilled pre-scraped fields by ID ──
  // Catches comboboxes not found by page.$$('input[role="combobox"]')
  if (preScraped?.fields) {
    const unfilled = (preScraped.fields as any[]).filter(
      (f: any) =>
        f.value &&
        f.source !== 'unknown' &&
        f.type === 'combobox' &&
        f.fieldId &&
        !filledIds.has(f.fieldId),
    );

    if (unfilled.length > 0) {
      console.log(`  Filling ${unfilled.length} remaining combobox fields by ID...`);

      for (const field of unfilled) {
        try {
          // Find the element by ID using attribute selector (safe for numeric IDs)
          const el = await page.$(`[id="${field.fieldId}"]`);
          if (!el) {
            console.log(`    ○ Element not found: #${field.fieldId} "${field.label}"`);
            continue;
          }

          // Check if already has a value
          const hasValue = await el
            .evaluate((e) => {
              const container = e.closest('[class*="select"]');
              const sv = container?.querySelector(
                '[class*="singleValue"], [class*="single-value"]',
              );
              return sv?.textContent?.trim() || '';
            })
            .catch(() => '');

          if (hasValue) {
            console.log(`    Already set: "${field.label}" = "${hasValue}"`);
            filledIds.add(field.fieldId);
            continue;
          }

          // Click to open, type answer, select from scoped menu
          await el.click({ timeout: 3000 }).catch(() => {});
          await sleep(300);
          await el.fill('');
          await el.type(field.value, { delay: 15 });
          await sleep(500);

          const menuId = (await el.getAttribute('aria-controls').catch(() => '')) || '';
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
                text.toLowerCase() === field.value.toLowerCase() ||
                text.toLowerCase().includes(field.value.toLowerCase()) ||
                field.value.toLowerCase().includes(text.toLowerCase())
              ) {
                await opts.nth(i).click({ timeout: 3000 });
                console.log(`    ✓ By ID: "${field.label}" → "${text}"`);
                clicked = true;
                filledIds.add(field.fieldId);
                break;
              }
            }
          }

          if (!clicked) {
            // Try pressing Enter on first filtered result
            await page.keyboard.press('Enter');
            await sleep(200);
            const newVal = await el
              .evaluate((e) => {
                const c = e.closest('[class*="select"]');
                const v = c?.querySelector('[class*="singleValue"]');
                return v?.textContent?.trim() || '';
              })
              .catch(() => '');
            if (newVal) {
              console.log(`    ✓ By ID: "${field.label}" → "${newVal}" (Enter)`);
              filledIds.add(field.fieldId);
            } else {
              await page.keyboard.press('Escape').catch(() => {});
              console.log(`    ○ By ID: "${field.label}" — failed`);
            }
          }
        } catch (err) {
          console.log(
            `    ○ By ID failed: "${field.label}" — ${(err as Error).message.slice(0, 50)}`,
          );
          await page.keyboard.press('Escape').catch(() => {});
        }
        await sleep(100);
      }
    }
  }

  // ── Ashby handled at top of fillFormFields — this block is dead code ──
  if (false) {
    // 1. Upload resume FIRST (Ashby re-renders form after upload)
    const resumeInput = await page.$(
      'input[type="file"][id="_systemfield_resume"], input[type="file"]',
    );
    if (resumeInput) {
      const resumeDir = path.join(__dirname, '../../../data/resume');
      try {
        const fs = await import('fs');
        const files = fs
          .readdirSync(resumeDir)
          .filter((f: string) => f.toLowerCase().endsWith('.pdf'));
        if (files.length > 0) {
          await resumeInput.setInputFiles(path.join(resumeDir, files[0]));
          console.log(`    ✓ Uploaded resume: ${files[0]}`);
          await sleep(2000); // Wait for Ashby to re-render after upload
        }
      } catch {
        /* skip */
      }
    }

    // 1b. Upload cover letter if field exists (re-query after resume upload re-render)
    await sleep(500);
    let coverLetterInput = await page.$('input[type="file"][id="cover_letter"]');
    if (!coverLetterInput) coverLetterInput = await page.$('input[type="file"][id*="cover"]');
    console.log(`    Cover letter input: ${coverLetterInput ? 'FOUND' : 'not found'}`);
    if (coverLetterInput) {
      try {
        // Get existing cover letter from DB
        const { CoverLetterModel } = await import('../../persistence/db');
        const { ApplicationFieldsModel } = await import('@job-agent/shared');
        let coverLetter = '';

        const preFilled = (await ApplicationFieldsModel.findOne({ externalJobId: job.id })
          .lean()
          .catch(() => null)) as any;
        if (preFilled?.coverLetter) coverLetter = preFilled.coverLetter;
        if (!coverLetter) {
          const existing = await CoverLetterModel.findOne({ externalJobId: job.id })
            .sort({ generatedAt: -1 })
            .lean()
            .catch(() => null);
          if ((existing as any)?.content) coverLetter = (existing as any).content;
        }
        if (coverLetter) {
          const tempDir = path.join(__dirname, '../../../data/cover-letters');
          const fsModule = await import('fs');
          fsModule.mkdirSync(tempDir, { recursive: true });
          const filename = `${job.company.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-cover-letter.txt`;
          const filepath = path.join(tempDir, filename);
          fsModule.writeFileSync(filepath, coverLetter);
          await coverLetterInput.setInputFiles(filepath);
          console.log(`    ✓ Uploaded cover letter (${coverLetter.length} chars)`);
          await sleep(1000);
        }
      } catch (err) {
        console.log(`    ○ Cover letter upload failed: ${(err as Error).message.slice(0, 50)}`);
      }
    }

    // 2. Fill text/email/tel inputs AFTER resume upload (avoids re-render clearing values)
    const allInputs = await page.$$(
      'input[type="text"], input[type="email"], input[type="tel"], input[type="url"]',
    );
    for (const inp of allInputs) {
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
      if (existing) {
        filledIds.add(id);
        continue;
      }

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

      if (value) {
        await inp.click();
        await inp.fill('');
        await inp.type(value, { delay: 5 });
        await sleep(100);
        filledIds.add(id);
        console.log(`    ✓ Filled (Ashby): "${label || id}" = "${value.slice(0, 40)}"`);
      }
    }

    // 3. Handle radio groups — use Playwright locator to click the option text directly
    const radioInputs = await page.$$('input[type="radio"]');
    if (radioInputs.length > 0) {
      // Group by name attribute
      const radioNames = new Set<string>();
      for (const r of radioInputs) {
        const name = (await r.getAttribute('name').catch(() => '')) || '';
        if (name) radioNames.add(name);
      }

      for (const name of radioNames) {
        // Check if already selected
        const checked = await page.$(`input[type="radio"][name="${name}"]:checked`);
        if (checked) continue;

        // Get the group label by finding the wrapper
        const firstRadio = await page.$(`input[type="radio"][name="${name}"]`);
        if (!firstRadio) continue;
        const groupLabel = await firstRadio
          .evaluate((el) => {
            // Walk up to find the field wrapper with the question label
            let node = el.parentElement;
            for (let i = 0; i < 10 && node; i++) {
              const label = node.querySelector('label');
              if (label && !label.querySelector('input')) {
                return label.textContent?.trim() || '';
              }
              node = node.parentElement;
            }
            return '';
          })
          .catch(() => '');

        if (!groupLabel) continue;

        // Get option labels
        const optionTexts = (await page
          .evaluate(
            `(() => {
          const radios = document.querySelectorAll('input[type="radio"][name="${name}"]');
          return Array.from(radios).map(r => {
            const label = r.closest('label') || r.parentElement;
            return (label?.textContent || '').trim();
          }).filter(t => t.length > 0);
        })()`,
          )
          .catch(() => [])) as string[];

        console.log(`    Radio "${groupLabel}": ${(optionTexts as string[]).join(' | ')}`);

        // Pick best option
        const gl = groupLabel.toLowerCase();
        let answer = '';
        if (
          gl.includes('work from') ||
          gl.includes('location') ||
          gl.includes('remote') ||
          gl.includes('office')
        ) {
          const opts = optionTexts as string[];
          answer =
            opts.find((o) => o.toLowerCase().includes('remote')) ||
            opts.find((o) => o.toLowerCase().includes('hybrid')) ||
            opts.find((o) => o.toLowerCase().includes('relocat')) ||
            opts[0] ||
            '';
        }

        if (answer) {
          // Click the label/container of the matching option
          const allRadios = await page.$$(`input[type="radio"][name="${name}"]`);
          for (const radio of allRadios) {
            const radioText = await radio
              .evaluate((el) => {
                const label = el.closest('label') || el.parentElement;
                return (label?.textContent || '').trim();
              })
              .catch(() => '');
            if (
              radioText.toLowerCase().includes(answer.toLowerCase()) ||
              answer.toLowerCase().includes(radioText.toLowerCase())
            ) {
              await radio.click({ force: true });
              console.log(`    ✓ Radio (Ashby): "${groupLabel}" → "${radioText}"`);
              break;
            }
          }
        }
      }
    }
    await sleep(300);
    // Skip all regular handlers for Ashby — already filled everything above
    return;
  }

  // ── Text inputs (skip file, hidden, and combobox inputs) ──
  try {
    const inputs = await page.$$(
      'form input[type="text"], form input[type="email"], form input[type="tel"], form input[type="number"], form input[type="url"]',
    );
    for (const input of inputs) {
      const isHidden = await input.isHidden().catch(() => true);
      if (isHidden) continue;

      const id = (await input.getAttribute('id').catch(() => '')) || '';

      // Skip combobox inputs and already-filled fields
      const role = await input.getAttribute('role').catch(() => '');
      if (role === 'combobox') continue;
      if (id && filledIds.has(id)) continue;

      const label = await this.fieldInspector.getFieldLabel(input, page);
      if (!label) continue;

      // Skip non-meaningful labels
      if (this.directAnswer.isSkippableLabel(label)) continue;

      const existing = await input.inputValue().catch(() => '');
      if (existing) {
        filledIds.add(id);
        continue;
      }

      console.log(`    Field: id="${id}" label="${label}" type="text"`);

      const resolved = await this.fieldAnswers.resolve({
        fieldId: id,
        label,
        type: 'text',
        profile,
        getPreScrapedAnswer,
        cache: answerCache,
        allowLlm: true,
        // A one-line input must not receive a paragraph.
        maxLength: 199,
      });
      if (resolved) {
        await input.fill(resolved.value);
        await sleep(100);
        console.log(`    ✓ Filled (${resolved.source}): "${label}" = "${resolved.value}"`);
        filledIds.add(id);
        continue;
      }

      // No LLM — leave unknown fields for user to fill manually
      console.log(`    ○ Skipped: "${label}" — no pre-scraped/rule/profile answer, fill manually`);
    }
  } catch (err) {
    console.log(`  ⚠ Text input handler error (continuing): ${(err as Error).message}`);
  }

  // ── Textareas (skip cover letter — handled separately) ──
  try {
    // Load cover letter for company-specific questions
    const { CoverLetterModel } = await import('../../persistence/db');
    const existingCoverLetter = await CoverLetterModel.findOne({ externalJobId: job.id })
      .sort({ generatedAt: -1 })
      .lean()
      .catch(() => null);
    const coverLetterText = (existingCoverLetter as any)?.content || '';

    const textareas = await page.$$('form textarea');
    for (const textarea of textareas) {
      const isHidden = await textarea.isHidden().catch(() => true);
      if (isHidden) continue;

      const label = await this.fieldInspector.getFieldLabel(textarea, page);
      if (!label || label.toLowerCase().includes('cover letter') || this.directAnswer.isSkippableLabel(label))
        continue;

      const existing = await textarea.inputValue().catch(() => '');
      if (existing) continue;

      // First pass without the model: a reviewed answer, if one exists, wins over
      // the cover-letter branch below.
      const reviewed = await this.fieldAnswers.resolve({
        label,
        type: 'textarea',
        profile,
        getPreScrapedAnswer,
        cache: answerCache,
      });
      if (reviewed) {
        await textarea.fill(reviewed.value);
        await sleep(200);
        console.log(`    ✓ Filled textarea (${reviewed.source}): "${label}"`);
        continue;
      }

      // Detect "why interested" / company-specific questions — use cover letter as reference
      const labelLower = label.toLowerCase();
      const isWhyQuestion = [
        'why are you interested',
        'why do you want to work',
        'why this company',
        'why this role',
        'what interests you about this',
        'what excites you about this',
        'what attracts you to this',
        'why should we hire you',
        'tell us why you',
        'why do you want to join',
      ].some((p) => labelLower.includes(p));

      if (isWhyQuestion && coverLetterText) {
        console.log(`    Company-specific question detected: "${label}" — using cover letter`);
        const { llmChat } = await import('@job-agent/shared');
        try {
          const response = await llmChat(
            `Based on this cover letter, write a 2-3 sentence answer to the question: "${label}"\n\nCover letter:\n${coverLetterText}\n\nJob: ${job.title} at ${job.company}\n\nWrite ONLY the answer, no preamble.`,
            { temperature: 0.2, maxTokens: 150 },
          );
          await textarea.fill(response);
          console.log(`    ✓ Filled (from cover letter): "${label}"`);
          await logQuestionAnswer(job.id, job.title, job.company, {
            question: label,
            type: 'textarea',
            answer: response,
            source: 'llm',
          }).catch(() => {});
          await sleep(200);
          continue;
        } catch {
          /* fall through to ask user */
        }
      }

      // Second pass, model permitted — this is the open-prose fallback.
      const generated = await this.fieldAnswers.resolve({
        label,
        type: 'textarea',
        profile,
        getPreScrapedAnswer,
        cache: answerCache,
        allowLlm: true,
      });
      if (!generated) {
        console.log(`    ○ Skipped textarea: "${label}" — fill manually`);
        continue;
      }
      await textarea.fill(generated.value);
      await sleep(200);
      console.log(`    Filled textarea (${generated.source}): "${label}"`);
    }
  } catch (err) {
    console.log(`  ⚠ Textarea handler error (continuing): ${(err as Error).message}`);
  }

  // ── Selects / Dropdowns — pick from available options only ──
  try {
    const selects = await page.$$('form select');
    for (const select of selects) {
      const isHidden = await select.isHidden().catch(() => true);
      if (isHidden) continue;

      const label = await this.fieldInspector.getFieldLabel(select, page);
      if (!label) continue;

      // Check if already selected (not on default empty option)
      const currentValue = await select
        .$eval('option:checked', (o: Element) => (o as HTMLOptionElement).value)
        .catch(() => '');
      if (currentValue) continue;

      const options = await select.$$eval('option:not([value=""])', (opts: Element[]) =>
        opts.map((o) => (o as HTMLOptionElement).text.trim()),
      );
      if (!options.length) continue;

      const resolvedSelect = await this.fieldAnswers.resolve({
        label,
        type: 'select',
        options,
        profile,
        getPreScrapedAnswer,
        cache: answerCache,
        allowLlm: true,
      });
      const bestOption = resolvedSelect?.value ?? '';
      if (!bestOption) {
        console.log(`    ○ Skipped select: "${label}" — fill manually`);
        continue;
      }

      await select.selectOption({ label: bestOption });
      console.log(`    Select: "${label}" → "${bestOption}"`);
      await logQuestionAnswer(job.id, job.title, job.company, {
        question: label,
        type: 'select',
        options: options.length <= 20 ? options : undefined,
        answer: bestOption,
        source: 'rule',
      }).catch(() => {});
      await sleep(100);
    }
  } catch (err) {
    console.log(`  ⚠ Select handler error (continuing): ${(err as Error).message}`);
  }

  // ── Radio buttons ──
  try {
    const fieldsets = await page.$$('form fieldset');
    for (const fieldset of fieldsets) {
      const legend = await fieldset
        .$eval('legend', (el: Element) => el.textContent?.trim() ?? '')
        .catch(() => '');
      if (!legend) continue;

      const radioLabels = await fieldset.$$eval('label', (labels: Element[]) =>
        labels.map((l) => l.textContent?.trim() ?? ''),
      );
      if (!radioLabels.length) continue;

      // Check if already selected
      const checked = await fieldset.$('input[type="radio"]:checked');
      if (checked) continue;

      const resolvedRadio = await this.fieldAnswers.resolve({
        label: legend,
        type: 'radio',
        options: radioLabels,
        profile,
        getPreScrapedAnswer,
        cache: answerCache,
        allowLlm: true,
      });
      const answer = resolvedRadio?.value ?? '';
      if (answer) console.log(`    ${legend} → "${answer}" (${resolvedRadio!.source})`);
      if (!answer) {
        console.log(`    ○ Skipped radio: "${legend}" — fill manually`);
        continue;
      }

      // Check if this fieldset has radio buttons or checkboxes
      const radios = await fieldset.$$('input[type="radio"]');
      const checkboxes = await fieldset.$$('input[type="checkbox"]');

      if (radios.length > 0) {
        // Single-select radio
        for (const radio of radios) {
          const radioId = await radio.getAttribute('id').catch(() => '');
          if (!radioId) continue;
          const radioLabel = await page
            .$eval(`label[for="${radioId}"]`, (el: Element) => el.textContent?.trim() ?? '')
            .catch(() => '');
          if (
            radioLabel.toLowerCase().includes(answer.toLowerCase()) ||
            answer.toLowerCase().includes(radioLabel.toLowerCase())
          ) {
            await radio.click();
            console.log(`    Radio: "${legend}" → "${radioLabel}"`);
            break;
          }
        }
      } else if (checkboxes.length > 0) {
        // Multi-select checkboxes ("select all that apply")
        const answers = answer.split(',').map((a) => a.trim().toLowerCase());
        for (const checkbox of checkboxes) {
          const cbId = await checkbox.getAttribute('id').catch(() => '');
          if (!cbId) continue;
          const cbLabel = await page
            .$eval(`label[for="${cbId}"]`, (el: Element) => el.textContent?.trim() ?? '')
            .catch(() => '');
          const shouldCheck = answers.some(
            (a) => cbLabel.toLowerCase().includes(a) || a.includes(cbLabel.toLowerCase()),
          );
          if (shouldCheck) {
            const isChecked = await checkbox.isChecked().catch(() => false);
            if (!isChecked) {
              await checkbox.click();
              console.log(`    Checkbox: "${legend}" → "${cbLabel}"`);
            }
          }
        }
      }
      await sleep(100);
    }
  } catch (err) {
    console.log(`  ⚠ Radio handler error (continuing): ${(err as Error).message}`);
  }
}

}
