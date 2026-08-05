import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import type { ScoredJob } from '../types';
import { answerQuestionWithPause } from './form-handler';
import { answerQuestion, clearRulesCache } from '../scorer/question-answerer';
import { TARGET_COMPANIES } from '../scraper/company-list';
import { saveCoverLetter, logQuestionAnswer, ProfileAnswerModel } from '../db';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => sleep(1500 + Math.random() * 2000);

// Type like a human — click, pause, then type with variable speed
async function humanType(element: any, text: string): Promise<void> {
  await element.click();
  await sleep(200 + Math.random() * 300);
  await element.fill('');
  await element.type(text, { delay: 20 + Math.random() * 40 });
}
const API_URL = process.env.API_URL || 'http://localhost:3001/api';

export type ApplicationResult =
  | { success: true; method: 'greenhouse' }
  | { success: false; reason: string };

async function getFieldLabel(element: any, page: Page): Promise<string> {
  // 1. Try aria-label (Greenhouse sets this reliably)
  const ariaLabel = await element.getAttribute('aria-label').catch(() => '');
  if (ariaLabel && ariaLabel.length < 200) return ariaLabel;

  // 2. Try associated label via id
  const id = await element.getAttribute('id').catch(() => '');
  if (id) {
    const label = await page
      .$eval(`label[for="${id}"]`, (el: Element) => {
        const clone = el.cloneNode(true) as HTMLElement;
        const nested = clone.querySelectorAll('span, abbr, small, svg, button');
        nested.forEach((n) => n.remove());
        return clone.textContent?.replace(/\*/g, '').trim() ?? '';
      })
      .catch(() => '');
    if (label && label.length > 0 && label.length < 300) return label;
  }

  // 3. Walk up to the field wrapper and find a nearby label (handles Greenhouse custom questions)
  const wrapperLabel = await element
    .evaluate((el: HTMLElement) => {
      let node: Element | null = el;
      for (let i = 0; i < 8 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        // Check wrapper-specific classes
        const classList =
          node.className && typeof node.className === 'string' ? node.className : '';
        if (/field|Field|question|Question/.test(classList) || node.tagName === 'FIELDSET') {
          // Find label inside the wrapper that isn't inside an input wrapper
          const legend = node.querySelector('legend');
          if (legend) {
            const txt = (legend.textContent || '').replace(/\*/g, '').trim();
            if (txt) return txt;
          }
          const labels = node.querySelectorAll('label');
          for (const label of Array.from(labels)) {
            if ((label as HTMLElement).contains(el)) continue; // skip self-containing labels
            const clone = label.cloneNode(true) as HTMLElement;
            clone
              .querySelectorAll('span, abbr, small, svg, button, input, textarea, select')
              .forEach((n) => n.remove());
            const txt = clone.textContent?.replace(/\*/g, '').trim() || '';
            if (txt && txt.length < 300) return txt;
          }
          // Check if the wrapper itself has a direct text child (question text)
          for (const child of Array.from(node.children)) {
            if (
              /label|heading|title/i.test(child.className || '') ||
              /^H[1-6]$/.test(child.tagName)
            ) {
              const txt = (child.textContent || '').replace(/\*/g, '').trim();
              if (txt && txt.length < 300) return txt;
            }
          }
        }
      }
      return '';
    })
    .catch(() => '');
  if (wrapperLabel) return wrapperLabel;

  // 4. Fall back to id as readable label (skipping generic question IDs)
  if (id && !/^question_\d+$/.test(id) && !/^\d+$/.test(id)) {
    const readable = id.replace(/[_\-]/g, ' ').trim();
    if (readable) return readable;
  }

  // 5. Try placeholder
  const placeholder = await element.getAttribute('placeholder').catch(() => '');
  if (placeholder && placeholder.length < 100) return placeholder;

  return '';
}

// Capture all form field values and save as Q&A log
async function captureFormAnswers(page: Page, job: ScoredJob): Promise<void> {
  try {
    const fields = await page.evaluate(() => {
      const results: { label: string; value: string; type: string }[] = [];

      document.querySelectorAll('input, textarea, select').forEach((el: any) => {
        if (el.offsetParent === null) return;
        if (
          el.type === 'file' ||
          el.type === 'hidden' ||
          el.type === 'submit' ||
          el.type === 'password'
        )
          return;

        const value = el.value?.trim() || '';
        if (!value) return;

        // Get label
        let label = '';
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) label = ariaLabel;
        if (!label && el.id) {
          const labelEl = document.querySelector('label[for="' + el.id + '"]');
          if (labelEl) {
            const clone = labelEl.cloneNode(true) as HTMLElement;
            clone.querySelectorAll('span, abbr, svg').forEach((n) => n.remove());
            label = clone.textContent?.replace(/\*/g, '').trim() || '';
          }
        }
        if (!label) label = el.id?.replace(/[_-]/g, ' ') || el.name?.replace(/[_-]/g, ' ') || '';
        if (!label || label.length < 2) return;

        // Skip common noise
        const lower = label.toLowerCase();
        if (['search', 'submit', 'apply'].includes(lower)) return;

        results.push({
          label,
          value,
          type: el.tagName.toLowerCase() === 'select' ? 'select' : el.type || 'text',
        });
      });

      // Capture checked radio buttons
      document.querySelectorAll('input[type="radio"]:checked').forEach((el: any) => {
        const fieldset = el.closest('fieldset');
        const legend = fieldset?.querySelector('legend')?.textContent?.trim() || '';
        const labelEl = document.querySelector('label[for="' + el.id + '"]');
        const value = labelEl?.textContent?.trim() || el.value || '';
        if (legend && value) results.push({ label: legend, value, type: 'radio' });
      });

      // Capture checked checkboxes
      document.querySelectorAll('input[type="checkbox"]:checked').forEach((el: any) => {
        const labelEl = document.querySelector('label[for="' + el.id + '"]');
        const label = labelEl?.textContent?.trim() || el.id?.replace(/[_-]/g, ' ') || '';
        if (label) results.push({ label, value: 'Yes', type: 'checkbox' });
      });

      // Also capture React Select values
      document.querySelectorAll('[class*="singleValue"], [class*="single-value"]').forEach((el) => {
        const container = el.closest('[class*="select"]');
        const input = container?.querySelector('input');
        const id = input?.id || '';
        let label = '';
        if (id) {
          const labelEl = document.querySelector('label[for="' + id + '"]');
          label = labelEl?.textContent?.replace(/\*/g, '').trim() || id.replace(/[_-]/g, ' ');
        }
        const value = el.textContent?.trim() || '';
        if (label && value) results.push({ label, value, type: 'select' });
      });

      return results;
    });

    // Skip basic profile fields, noise, and huge option lists
    const skipLabels = [
      'first name',
      'last name',
      'email',
      'phone',
      'preferred name',
      'name',
      'country',
      'country code',
      'search',
      'attach',
      'upload',
      'iti',
    ];

    const newFields = fields.filter((f) => {
      const lower = f.label.toLowerCase();
      if (skipLabels.some((s) => lower === s || lower.includes(s))) return false;
      if (f.value.length > 300) return false;
      if (f.label.length < 5) return false;
      // Skip if label is just a number (dropdown option IDs)
      if (/^\d+$/.test(f.label.trim())) return false;
      // Skip if value is just a number (option IDs)
      if (/^\d{5,}$/.test(f.value.trim())) return false;
      // Skip if value looks like a country list
      if (f.value.includes('+93') || f.value.includes('Afghanistan')) return false;
      // Skip phone code values like "United States +1"
      if (f.value.match(/\+\d+$/)) return false;
      // Skip standalone country/city names as labels (not questions)
      if (
        lower.length < 20 &&
        !lower.includes('?') &&
        !lower.includes('select') &&
        !lower.includes('please') &&
        [
          'australia',
          'brazil',
          'canada',
          'france',
          'germany',
          'india',
          'ireland',
          'israel',
          'japan',
          'mexico',
          'netherlands',
          'new zealand',
          'singapore',
          'south korea',
          'spain',
          'sweden',
          'switzerland',
          'thailand',
          'vietnam',
          'poland',
          'portugal',
          'romania',
          'united kingdom',
          'united states',
          'united arab emirates',
        ].includes(lower)
      )
        return false;
      return true;
    });
    console.log(`  Recording ${newFields.length} form answers as reusable rules...`);

    for (const field of newFields) {
      // Log to Q&A history — never include options
      await logQuestionAnswer(job.id, job.title, job.company, {
        question: field.label,
        type: field.type as any,
        answer: field.value,
        source: 'rule',
      }).catch(() => {});

      // Save as reusable rule for future auto-fill
      const normalized = field.label
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .trim();
      if (normalized.length >= 3 && field.value.length < 500) {
        await ProfileAnswerModel.findOneAndUpdate(
          { question_pattern: normalized },
          { $set: { answer: field.value, source: 'auto' } },
          { upsert: true },
        ).catch(() => {});
      }
    }
    // Clear cached rules so next job picks up new answers
    clearRulesCache();
  } catch (err) {
    console.log(`  Failed to capture form answers: ${(err as Error).message}`);
  }
}

let formPageUrl = '';

function setFormPageUrl(url: string) {
  formPageUrl = url;
}

async function detectSubmissionSuccess(page: Page): Promise<boolean> {
  try {
    const currentUrl = page.url();

    // Must still be on a greenhouse-related page
    if (!currentUrl.includes('greenhouse') && !currentUrl.includes(formPageUrl)) return false;

    // The submit button must be GONE — this is the strongest signal
    const submitBtn = await page.$(
      'form button[type="submit"], button:has-text("Submit Application"), button:has-text("Submit")',
    );
    if (submitBtn) {
      // Submit button still visible = form still active, not submitted
      return false;
    }

    // Also check that the form fields are gone
    const formField = await page.$('input[id="first_name"], input[id="email"], form textarea');
    if (formField) return false;

    // Now check for success text
    const bodyText = (await page.textContent('body').catch(() => '')) || '';
    const lower = bodyText.toLowerCase();

    const successIndicators = [
      'thank you for applying',
      'thanks for applying',
      'application submitted',
      'application has been submitted',
      'received your application',
      'successfully submitted',
      'we have received your application',
      'application received',
      'your application has been received',
      'thank you for your interest',
      'thanks for your interest',
    ];

    const matched = successIndicators.find((indicator) => lower.includes(indicator));
    if (matched) {
      console.log(`  [detection] Success indicator found: "${matched}"`);
      console.log(`  [detection] URL: ${currentUrl}`);
    }
    return !!matched;
  } catch {
    return false;
  }
}

async function waitForUserConfirmation(job: ScoredJob): Promise<'submit' | 'manual' | 'skip'> {
  try {
    const { data: pending } = await axios.post(`${API_URL}/form-answers/pending`, {
      jobTitle: job.title,
      company: job.company,
      question: `Review the form for "${job.title}" at ${job.company}. Check all fields in the browser are correct.`,
      type: 'select',
      options: ['Submit (bot clicks submit)', 'Already submitted manually', 'Skip this job'],
    });

    // Poll for answer
    const maxWait = 10 * 60 * 1000; // 10 min
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      await sleep(2000);
      const { data: q } = await axios.get(`${API_URL}/form-answers/pending/${pending.id}`);
      if (q?.answer) {
        const ans = q.answer.toLowerCase();
        console.log(`    User responded: "${q.answer}"`);
        if (ans.includes('already') || ans.includes('manual')) return 'manual';
        if (ans.includes('skip') || ans === '__skip__') return 'skip';
        return 'submit';
      }
    }

    return 'skip';
  } catch {
    return false;
  }
}

// Build direct Greenhouse application URL from job data
function getGreenhouseDirectUrl(job: ScoredJob): string | null {
  // Extract gh_jid from URL like ?gh_jid=7091959
  const ghJidMatch = job.url.match(/gh_jid=(\d+)/);
  if (!ghJidMatch) {
    // Already a greenhouse URL like job-boards.greenhouse.io/stripe/jobs/123
    if (job.url.includes('greenhouse.io')) return job.url;
    return null;
  }

  const jobId = ghJidMatch[1];

  // Find company slug from TARGET_COMPANIES
  const company = TARGET_COMPANIES.find((c) => c.name.toLowerCase() === job.company.toLowerCase());

  if (company) {
    return `https://job-boards.greenhouse.io/${company.slug}/jobs/${jobId}`;
  }

  // Fallback: try lowercase company name as slug
  const slugGuess = job.company.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `https://job-boards.greenhouse.io/${slugGuess}/jobs/${jobId}`;
}

// ── LLM fallback for unknown fields ──
async function askLLMForAnswer(
  label: string,
  job: ScoredJob,
  profile: any,
  type: 'text' | 'textarea' | 'select' | 'radio',
  options?: string[],
): Promise<string> {
  const { llmChat } = await import('@job-agent/shared');

  // Load cover letter for context
  const { CoverLetterModel } = await import('../db');
  const cl = await CoverLetterModel.findOne({ externalJobId: job.id })
    .sort({ generatedAt: -1 })
    .lean()
    .catch(() => null);
  const clContext = (cl as any)?.content
    ? `\nCover letter for reference:\n${(cl as any).content}`
    : '';

  let prompt = '';

  const candidateInfo = `${profile?.personal?.name || 'Parinita Kumari'}, Female, located in ${profile?.preferences?.location?.current_city || 'Fremont, CA'}, United States. ${profile?.experience?.total_years || 7} years ${profile?.experience?.current_level || 'Backend Engineer'}. Authorized to work in US, no sponsorship needed. Asian, not Hispanic/Latino, not a veteran, no disability.`;

  if ((type === 'select' || type === 'radio') && options?.length) {
    prompt = `Pick the best option for this job application question.
Question: "${label}"
Options: ${options.join(', ')}
Job: ${job.title} at ${job.company}
Candidate: ${candidateInfo}
Skills: ${(profile?.skills?.languages || []).join(', ')}

Reply with ONLY the exact text of the best option. Nothing else.`;
  } else if (type === 'textarea') {
    prompt = `Answer this job application question in 2-3 sentences.
Question: "${label}"
Job: ${job.title} at ${job.company}
Candidate: ${candidateInfo}
Skills: ${(profile?.skills?.languages || []).join(', ')}, ${(profile?.skills?.frameworks || []).join(', ')}
Architecture: ${(profile?.skills?.architecture || []).join(', ')}
${clContext}

Answer directly and specifically. No preamble.`;
  } else {
    prompt = `Answer this job application field concisely.
Field: "${label}"
Job: ${job.title} at ${job.company}
Candidate: ${candidateInfo}

Reply with ONLY the answer, nothing else. Keep it under 100 characters.`;
  }

  const answer = await llmChat(prompt, { maxTokens: type === 'textarea' ? 300 : 100 });

  // Don't auto-save LLM answers as rules — only user edits should create rules
  return answer;
}

// Labels that aren't real questions — skip these
function isSkippableLabel(label: string): boolean {
  const lower = label.toLowerCase().trim();
  const skip = [
    'attach',
    'upload',
    'drag',
    'drop',
    'browse',
    'choose file',
    'or',
    'and',
    'submit',
    'apply',
    'cancel',
    'back',
    'next',
    'required',
    'optional',
    'enter manually',
    'search',
    'select',
    'type to search',
  ];
  if (skip.includes(lower)) return true;
  if (lower.length < 2) return true;
  if (lower.length > 150) return true;
  // Skip if it's just a number or punctuation
  if (/^[\d\s\-_.*]+$/.test(lower)) return true;
  return false;
}

// Map known field IDs/labels to profile data — these should never go to LLM
// fieldType: pass 'text' for text inputs, 'select'/'radio' for dropdowns
function getDirectAnswer(
  id: string,
  label: string,
  profile: any,
  fieldType: string = 'text',
): string | null {
  const idLower = id.toLowerCase();
  const labelLower = label.toLowerCase();

  if (
    idLower === 'first_name' ||
    idLower === 'firstname' ||
    labelLower === 'first name' ||
    labelLower === 'first name'
  ) {
    return profile?.personal?.name?.split(' ')[0] || '';
  }
  if (
    idLower === 'last_name' ||
    idLower === 'lastname' ||
    labelLower === 'last name' ||
    labelLower === 'last name' ||
    labelLower === 'surname'
  ) {
    const parts = profile?.personal?.name?.split(' ') || [];
    return parts.slice(1).join(' ') || '';
  }
  if (idLower === 'name' || labelLower === 'name' || labelLower === 'full name') {
    return profile?.personal?.name || '';
  }
  if (
    idLower === 'preferred_name' ||
    idLower === 'preferredname' ||
    labelLower.includes('preferred')
  ) {
    return profile?.personal?.name?.split(' ')[0] || '';
  }
  if (idLower === 'email' || labelLower === 'email' || labelLower === 'email address') {
    return profile?.personal?.email || '';
  }
  if (idLower === 'phone' || labelLower === 'phone' || labelLower === 'phone number') {
    return profile?.personal?.phone || '';
  }
  if (labelLower.includes('linkedin')) {
    return profile?.personal?.linkedin || '';
  }
  if (
    labelLower.includes('website') ||
    labelLower.includes('github') ||
    labelLower.includes('portfolio') ||
    labelLower.includes('url')
  ) {
    return profile?.personal?.github || '';
  }

  // ── Work authorization (MUST be before location checks) ──
  // Only return Yes/No for non-text fields — text inputs with these labels are usually dropdowns
  if (fieldType !== 'text') {
    if (
      labelLower.includes('authorized to work') ||
      labelLower.includes('legally authorized') ||
      labelLower.includes('eligible to work') ||
      labelLower.includes('work authorization') ||
      labelLower.includes('right to work') ||
      labelLower.includes('legally eligible')
    ) {
      return 'Yes';
    }
    if (
      labelLower.includes('visa sponsorship') ||
      labelLower.includes('require sponsorship') ||
      labelLower.includes('need sponsorship') ||
      labelLower.includes('immigration sponsorship')
    ) {
      return 'No';
    }
  }

  // Location — require word boundaries on short keywords to avoid matching inside "ethniCITY" / "STATEs".
  if (
    /\bcity\b/.test(labelLower) ||
    labelLower.includes('location') ||
    labelLower.includes('address')
  ) {
    return profile?.preferences?.location?.current_city || profile?.personal?.location || '';
  }
  if (/\bstate\b/.test(labelLower) || /\bprovince\b/.test(labelLower)) {
    return 'California';
  }
  if (/\bzip\b/.test(labelLower) || labelLower.includes('postal')) {
    return '95134';
  }
  if (
    idLower === 'country' ||
    labelLower === 'country' ||
    (labelLower.includes('country') && !/\bcity\b/.test(labelLower))
  ) {
    return 'United States';
  }

  // ── Compensation ──
  if (
    labelLower.includes('salary') ||
    labelLower.includes('compensation') ||
    labelLower.includes('pay expectation') ||
    labelLower.includes('desired pay')
  ) {
    return String(profile?.compensation?.base_salary_preferred || '180000');
  }
  if (
    labelLower.includes('salary expectation') ||
    labelLower.includes('expected salary') ||
    labelLower.includes('minimum salary')
  ) {
    return String(profile?.compensation?.base_salary_min || '150000');
  }

  // ── Experience ──
  if (
    labelLower.includes('years of experience') ||
    labelLower.includes('total experience') ||
    labelLower.includes('how many years')
  ) {
    return String(profile?.experience?.total_years || '7');
  }
  if (
    labelLower.includes('current title') ||
    labelLower.includes('job title') ||
    labelLower.includes('current role')
  ) {
    return profile?.experience?.current_level || 'Backend Engineer';
  }
  if (
    labelLower.includes('current company') ||
    labelLower.includes('current employer') ||
    labelLower.includes('most recent company')
  ) {
    const latest = profile?.work_history?.[0];
    return latest?.company || '';
  }

  // ── Availability ──
  if (
    labelLower.includes('start date') ||
    labelLower.includes('when can you start') ||
    labelLower.includes('earliest start') ||
    labelLower.includes('available to start') ||
    labelLower.includes('notice period')
  ) {
    return '2 weeks';
  }

  // ── Questions that ALWAYS have a clear answer regardless of field type ──

  // Sponsorship / visa — always No
  if (
    labelLower.includes('require sponsorship') ||
    labelLower.includes('need sponsorship') ||
    labelLower.includes('require.*visa') ||
    labelLower.includes('sponsorship for employment') ||
    labelLower.includes('immigration sponsorship') ||
    labelLower.includes('visa sponsorship') ||
    labelLower.includes('visa status') ||
    labelLower.includes('require.*immigration')
  ) {
    return 'No';
  }

  // Work authorization — always Yes
  if (
    labelLower.includes('authorized to work') ||
    labelLower.includes('legally authorized') ||
    labelLower.includes('eligible to work') ||
    labelLower.includes('work authorization') ||
    labelLower.includes('right to work') ||
    labelLower.includes('legally eligible') ||
    labelLower.includes('legal right to work') ||
    labelLower.includes('work legally')
  ) {
    return 'Yes';
  }

  // Relocation — always Yes
  if (
    labelLower.includes('willing to relocate') ||
    labelLower.includes('open to relocation') ||
    labelLower.includes('relocate if') ||
    labelLower.includes('willing to move')
  ) {
    return 'Yes';
  }

  // Background check — always Yes
  if (
    labelLower.includes('background check') ||
    labelLower.includes('drug test') ||
    labelLower.includes('drug screen') ||
    labelLower.includes('consent to')
  ) {
    return 'Yes';
  }

  // Commute / in-person — always Yes
  if (
    labelLower.includes('able to commute') ||
    labelLower.includes('commute to') ||
    labelLower.includes('work in person') ||
    labelLower.includes('in-person') ||
    labelLower.includes('on-site') ||
    labelLower.includes('onsite') ||
    labelLower.includes('hybrid')
  ) {
    return 'Yes';
  }

  // Employment type
  if (labelLower.includes('employment type') || labelLower.includes('work type')) {
    return 'Full-time';
  }

  // Education
  if (
    labelLower.includes('degree') ||
    labelLower.includes('education level') ||
    labelLower.includes('highest education')
  ) {
    return 'B. Tech';
  }
  if (
    labelLower.includes('university') ||
    labelLower.includes('school') ||
    labelLower.includes('college') ||
    labelLower.includes('institution')
  ) {
    return 'DIT University';
  }
  if (
    labelLower.includes('major') ||
    labelLower.includes('field of study') ||
    labelLower.includes('discipline')
  ) {
    return 'Computer Science';
  }
  if (labelLower.includes('graduation') || labelLower.includes('year of completion')) {
    return '2018';
  }

  // How did you hear
  if (
    labelLower.includes('how did you hear') ||
    labelLower.includes('where did you find') ||
    labelLower.includes('referral source') ||
    labelLower.includes('how did you learn')
  ) {
    return 'LinkedIn';
  }

  // Demographics — always answer
  if (labelLower.includes('gender')) return 'Female';
  if (labelLower.includes('race') || labelLower.includes('ethnicity')) return 'Asian';
  if (labelLower.includes('veteran')) return 'No';
  if (labelLower.includes('disability') || labelLower.includes('handicap')) return 'No';
  if (labelLower.includes('lgbtq') || labelLower.includes('sexual orientation'))
    return 'Heterosexual';
  if (labelLower.includes('pronoun')) return 'She/Her';

  // ── Generic yes/no — only for dropdowns, not text inputs ──
  if (fieldType === 'text') return null;

  const yesPatterns = [
    'are you open to',
    'are you willing',
    'are you able',
    'are you comfortable',
    'are you available',
    'are you interested',
    'do you have the right',
    'do you have authorization',
    'can you commute',
    'can you work',
    'can you start',
    'will you be able',
    'would you be open',
    'do you agree',
    'acknowledge',
  ];
  if (yesPatterns.some((p) => labelLower.includes(p))) return 'Yes';

  const noPatterns = [
    'non-compete',
    'non compete',
    'previously applied',
    'applied before',
    'government employee',
    'government official',
  ];
  if (noPatterns.some((p) => labelLower.includes(p))) return 'No';

  return null;
}

// Smart matcher: maps a short answer (e.g. "United States", "Female", "No") to the best dropdown option
// without LLM — handles common variations deterministically
export function smartMatchOption(answer: string, options: string[], label: string): string | null {
  const a = answer.toLowerCase().trim();
  const l = label.toLowerCase();

  // Exact match
  const exact = options.find((o) => o.toLowerCase().trim() === a);
  if (exact) return exact;

  // ── Specific matchers BEFORE generic contains (to avoid wrong partial matches) ──

  // Country variations: "United States" → "US", "USA", "United States of America"
  if (a === 'united states' || a === 'us' || a === 'usa') {
    const countryMatch = options.find((o) => {
      const ol = o.toLowerCase();
      return (
        ol === 'us' ||
        ol === 'usa' ||
        ol.includes('united states') ||
        ol.startsWith('us ') ||
        ol === 'u.s.' ||
        ol === 'u.s.a.'
      );
    });
    if (countryMatch) return countryMatch;
  }

  // Yes/No — match options that START with Yes/No (e.g. "Yes, I am authorized...", "No, I will not require...")
  if (a === 'yes' || a === 'no') {
    const ynMatch = options.find((o) => o.toLowerCase().startsWith(a));
    if (ynMatch) return ynMatch;
    // Also match "I am" / "I do" for Yes, "I am not" / "I do not" for No
    if (a === 'yes') {
      const posMatch = options.find((o) => {
        const ol = o.toLowerCase();
        return (
          (ol.includes('i am') && !ol.includes('not')) ||
          (ol.includes('i do') && !ol.includes('not')) ||
          (ol.includes('i will') && !ol.includes('not')) ||
          ol.includes('i intend')
        );
      });
      if (posMatch) return posMatch;
    }
    if (a === 'no') {
      const negMatch = options.find((o) => {
        const ol = o.toLowerCase();
        return (
          ol.includes('i am not') ||
          ol.includes('i do not') ||
          ol.includes('i will not') ||
          ol.includes('not a') ||
          ol.includes('do not have')
        );
      });
      if (negMatch) return negMatch;
    }
  }

  // Gender: "Female" ↔ "Woman", "Male" ↔ "Man"
  if (a === 'female' || a === 'woman') {
    return (
      options.find(
        (o) => o.toLowerCase().includes('female') || o.toLowerCase().includes('woman'),
      ) || null
    );
  }
  if (a === 'male' || a === 'man') {
    return (
      options.find(
        (o) =>
          (o.toLowerCase().includes('male') && !o.toLowerCase().includes('female')) ||
          o.toLowerCase().includes('man'),
      ) || null
    );
  }

  // Gender identity: "Cisgender" ↔ "Straight" (for "I identify as" questions)
  if (a === 'cisgender' || a === 'straight' || a === 'heterosexual') {
    return (
      options.find((o) => o.toLowerCase().includes('cisgender')) ||
      options.find((o) => o.toLowerCase().includes('heterosexual')) ||
      options.find((o) => o.toLowerCase().includes('straight')) ||
      null
    );
  }

  // Race/Ethnicity patterns
  if (a === 'south asian' || a === 'asian') {
    // Prefer specific "South Asian" if available, then exact "Asian", then any "asian"
    return (
      options.find((o) => o.toLowerCase().includes('south asian')) ||
      options.find(
        (o) => o.toLowerCase().trim() === 'asian' || o.toLowerCase().startsWith('asian'),
      ) ||
      options.find((o) => o.toLowerCase().includes('asian')) ||
      null
    );
  }
  if (a === 'white' || a === 'caucasian') {
    return (
      options.find(
        (o) => o.toLowerCase().includes('white') || o.toLowerCase().includes('caucasian'),
      ) || null
    );
  }
  if (a === 'black' || a === 'african american') {
    return (
      options.find(
        (o) => o.toLowerCase().includes('black') || o.toLowerCase().includes('african american'),
      ) || null
    );
  }
  if (a === 'hispanic' || a === 'latino' || a === 'latina') {
    return (
      options.find(
        (o) => o.toLowerCase().includes('hispanic') || o.toLowerCase().includes('latino'),
      ) || null
    );
  }
  if (l.includes('race') || l.includes('ethnicity')) {
    // Generic race question — try contains match with the answer
    const raceMatch = options.find((o) => o.toLowerCase().includes(a));
    if (raceMatch) return raceMatch;
  }

  // Sexual orientation: "Heterosexual" ↔ "Straight"
  if (a === 'heterosexual' || a === 'straight') {
    return (
      options.find((o) => o.toLowerCase().includes('heterosexual')) ||
      options.find((o) => o.toLowerCase().includes('straight')) ||
      null
    );
  }

  // Veteran: "No" → "I am not a protected veteran", "No"
  if (l.includes('veteran') && a === 'no') {
    return (
      options.find((o) => o.toLowerCase().includes('not') && o.toLowerCase().includes('veteran')) ||
      options.find((o) => o.toLowerCase().startsWith('no')) ||
      null
    );
  }

  // Disability: "No" → "No, I do not have a disability", etc.
  if (l.includes('disability') && a === 'no') {
    return (
      options.find(
        (o) => o.toLowerCase().includes('do not have') || o.toLowerCase().includes('no,'),
      ) ||
      options.find((o) => o.toLowerCase().startsWith('no')) ||
      null
    );
  }

  // Decline to answer / prefer not patterns
  if (a === 'decline' || a === 'prefer not') {
    return (
      options.find(
        (o) => o.toLowerCase().includes('decline') || o.toLowerCase().includes('prefer not'),
      ) || null
    );
  }

  // Contains match (both directions) — AFTER specific matchers
  const contains = options.find((o) => {
    const ol = o.toLowerCase();
    return ol.includes(a) || a.includes(ol);
  });
  if (contains) return contains;

  // Starts-with match
  const startsWith = options.find((o) => o.toLowerCase().startsWith(a));
  if (startsWith) return startsWith;

  return null;
}

async function fillAshbyForm(
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
      const resumeDir = path.join(__dirname, '../../data/resume');
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
        const { CoverLetterModel } = await import('../db');
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
          const tempDir = path.join(__dirname, '../../data/cover-letters');
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
            const directAnswer = getDirectAnswer(id, label || placeholder, profile);
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
      const answer = getDirectAnswer('', label, profile, 'select');
      if (answer) {
        const matched = smartMatchOption(answer, options, label);
        if (matched) {
          await sel.selectOption({ label: matched });
          console.log(`    ✓ Select: "${label}" → "${matched}"`);
          continue;
        }
      }
      // Try pre-scraped
      const preAnswer = getPreScrapedAnswer('', label);
      if (preAnswer) {
        const matched = smartMatchOption(preAnswer, options, label);
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
      if (!answer) answer = getDirectAnswer(id, label, profile, 'select');
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
        if (!answer) answer = getDirectAnswer('', label, profile, 'select');
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

        const answer = getDirectAnswer('', label, profile, 'select');
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

        const firstRadio = await page.$(`input[type="radio"][name="${name}"]`);
        if (!firstRadio) continue;
        const groupLabel = await firstRadio
          .evaluate((el) => {
            // Walk up to find fieldset or field wrapper, get the question label (not option label)
            let node: Element | null = el;
            for (let i = 0; i < 10 && node; i++) {
              node = node.parentElement;
              if (!node) break;
              // Check for fieldset legend
              const legend = node.querySelector('legend');
              if (legend) return legend.textContent?.trim() || '';
              // Check for a label that is a DIRECT child (not nested inside options)
              const labels = node.querySelectorAll(':scope > label');
              for (const label of Array.from(labels)) {
                if (!label.querySelector('input')) return label.textContent?.trim() || '';
              }
            }
            return '';
          })
          .catch(() => '');
        if (!groupLabel) continue;

        // Get option texts
        const allRadios = await page.$$(`input[type="radio"][name="${name}"]`);
        const optionTexts: string[] = [];
        for (const radio of allRadios) {
          const text = await radio
            .evaluate((el) => {
              // Ashby: option text is in nextSibling of parent span, or in parent's parent div
              const parentSpan = el.parentElement;
              const nextSibling = parentSpan?.nextElementSibling;
              if (nextSibling?.textContent?.trim()) return nextSibling.textContent.trim();
              // Try parent div (contains full option text)
              const optionDiv = parentSpan?.parentElement;
              if (optionDiv?.textContent?.trim()) return optionDiv.textContent.trim();
              // Fallback: label or parent
              const label = el.closest('label');
              return (label?.textContent || '').trim();
            })
            .catch(() => '');
          if (text) optionTexts.push(text);
        }

        console.log(`    Radio "${groupLabel}": ${optionTexts.join(' | ')}`);

        // Pick best option
        const gl = groupLabel.toLowerCase();
        const hasLocationOptions = optionTexts.some(
          (o) =>
            o.toLowerCase().includes('remote') ||
            o.toLowerCase().includes('hybrid') ||
            o.toLowerCase().includes('nyc') ||
            o.toLowerCase().includes('office') ||
            o.toLowerCase().includes('relocat'),
        );
        let answer = '';
        if (
          gl.includes('work') ||
          gl.includes('location') ||
          gl.includes('remote') ||
          gl.includes('office') ||
          gl.includes('where') ||
          hasLocationOptions
        ) {
          answer =
            optionTexts.find((o) => o.toLowerCase().includes('remote')) ||
            optionTexts.find((o) => o.toLowerCase().includes('hybrid')) ||
            optionTexts.find((o) => o.toLowerCase().includes('relocat')) ||
            optionTexts[0] ||
            '';
        }

        if (answer) {
          for (const radio of allRadios) {
            const radioText = await radio
              .evaluate((el) => {
                const parentSpan = el.parentElement;
                const nextSibling = parentSpan?.nextElementSibling;
                if (nextSibling?.textContent?.trim()) return nextSibling.textContent.trim();
                const optionDiv = parentSpan?.parentElement;
                if (optionDiv?.textContent?.trim()) return optionDiv.textContent.trim();
                const label = el.closest('label');
                return (label?.textContent || '').trim();
              })
              .catch(() => '');
            if (
              radioText.toLowerCase().includes(answer.toLowerCase()) ||
              answer.toLowerCase().includes(radioText.toLowerCase())
            ) {
              await radio.click({ force: true });
              console.log(`    ✓ Radio: "${groupLabel}" → "${radioText}"`);
              break;
            }
          }
        }
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

async function fillFormFields(page: Page, job: ScoredJob): Promise<void> {
  // Load profile for direct field mapping
  const { loadProfile } = await import('../db');
  const profile = await loadProfile();

  // Load pre-scraped answers (from Prepare tab) — use these first, skip LLM calls
  const { ApplicationFieldsModel } = await import('@job-agent/shared');
  const preScraped = (await ApplicationFieldsModel.findOne({ externalJobId: job.id })
    .lean()
    .catch(() => null)) as any;
  // Filter out LLM refusal paragraphs stored in legacy pre-scraped data
  function isRefusalText(v: string): boolean {
    if (!v) return true;
    const t = v.trim().toLowerCase();
    if (t.length > 400) return true;
    const markers = [
      "i can't answer",
      'i cannot answer',
      "i don't wish to",
      'the candidate should',
      'candidate needs to',
      'candidate themselves',
      'i decline to',
      "i shouldn't guess",
      "i'm not able to",
      'i am not able to',
      'only the candidate',
      'inferred from',
      'not included in',
      'sensitive personal',
      'this is personal',
    ];
    return markers.some((m) => t.includes(m));
  }

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
    await fillAshbyForm(page, job, profile, getPreScrapedAnswer);
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

        const label = await getFieldLabel(combo, page);
        if (!label || isSkippableLabel(label)) {
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

        // Resolve answer: pre-scraped → rules → profile (NO LLM)
        let answer = '';
        const preAnswer = getPreScrapedAnswer(id, label);
        if (preAnswer) {
          answer = preAnswer;
        }
        if (!answer) {
          try {
            const ruleAnswer = await answerQuestion(label, 'select');
            if (ruleAnswer && !isRefusalText(ruleAnswer)) answer = ruleAnswer;
          } catch {
            /* fall through */
          }
        }
        if (!answer) {
          const directAnswer = getDirectAnswer(id, label, profile, 'select');
          if (directAnswer) answer = directAnswer;
        }

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
            const smart = smartMatchOption(
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
      const resumeDir = path.join(__dirname, '../../data/resume');
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
        const { CoverLetterModel } = await import('../db');
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
          const tempDir = path.join(__dirname, '../../data/cover-letters');
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

      const label = await getFieldLabel(input, page);
      if (!label) continue;

      // Skip non-meaningful labels
      if (isSkippableLabel(label)) continue;

      const existing = await input.inputValue().catch(() => '');
      if (existing) {
        filledIds.add(id);
        continue;
      }

      console.log(`    Field: id="${id}" label="${label}" type="text"`);

      // Try pre-scraped answer first (already reviewed — fill instantly)
      const preAnswer = getPreScrapedAnswer(id, label);
      if (preAnswer !== null) {
        await input.fill(preAnswer);
        await sleep(100);
        console.log(`    ✓ Filled (pre-scraped): "${label}" = "${preAnswer}"`);
        filledIds.add(id);
        continue;
      }

      // Try saved rules first (user corrections override hardcoded defaults)
      try {
        const ruleAnswer = await answerQuestion(label, 'text');
        if (
          ruleAnswer &&
          ruleAnswer.length > 0 &&
          ruleAnswer.length < 200 &&
          !isRefusalText(ruleAnswer)
        ) {
          await input.fill(ruleAnswer);
          await sleep(100);
          console.log(`    ✓ Filled (rule): "${label}" = "${ruleAnswer}"`);
          filledIds.add(id);
          continue;
        }
      } catch {
        /* fall through */
      }

      // Try hardcoded profile mapping as fallback
      const directAnswer = getDirectAnswer(id, label, profile);
      if (directAnswer !== null) {
        await input.fill(directAnswer);
        await sleep(100);
        console.log(`    ✓ Filled (profile): "${label}" = "${directAnswer}"`);
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
    const { CoverLetterModel } = await import('../db');
    const existingCoverLetter = await CoverLetterModel.findOne({ externalJobId: job.id })
      .sort({ generatedAt: -1 })
      .lean()
      .catch(() => null);
    const coverLetterText = (existingCoverLetter as any)?.content || '';

    const textareas = await page.$$('form textarea');
    for (const textarea of textareas) {
      const isHidden = await textarea.isHidden().catch(() => true);
      if (isHidden) continue;

      const label = await getFieldLabel(textarea, page);
      if (!label || label.toLowerCase().includes('cover letter') || isSkippableLabel(label))
        continue;

      const existing = await textarea.inputValue().catch(() => '');
      if (existing) continue;

      // Try pre-scraped answer first
      const preAnswer = getPreScrapedAnswer('', label);
      if (preAnswer) {
        await textarea.fill(preAnswer);
        await sleep(200);
        console.log(`    ✓ Filled textarea (pre-scraped): "${label}"`);
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

      // Try rule-based, skip if unknown — user fills manually
      let answer = '';
      try {
        const ruleAnswer = await answerQuestion(label, 'textarea');
        if (ruleAnswer && ruleAnswer.length > 0 && !isRefusalText(ruleAnswer)) answer = ruleAnswer;
      } catch {
        /* skip */
      }

      if (!answer) {
        console.log(`    ○ Skipped textarea: "${label}" — fill manually`);
        continue;
      }

      if (answer) {
        await textarea.fill(answer);
        await sleep(200);
        console.log(`    Filled textarea: "${label}"`);
      }
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

      const label = await getFieldLabel(select, page);
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

      // Resolve answer: pre-scraped → rules → profile (NO LLM), all via smartMatchOption
      let bestOption = '';
      const preAnswer = getPreScrapedAnswer('', label);
      if (preAnswer) {
        const matched = smartMatchOption(preAnswer, options, label);
        if (matched) bestOption = matched;
      }
      if (!bestOption) {
        try {
          const ruleAnswer = await answerQuestion(label, 'select', options);
          if (ruleAnswer && !isRefusalText(ruleAnswer)) {
            const matched = smartMatchOption(ruleAnswer, options, label);
            if (matched) bestOption = matched;
          }
        } catch {
          /* skip */
        }
      }
      if (!bestOption) {
        const directAnswer = getDirectAnswer('', label, profile, 'select');
        if (directAnswer) {
          const matched = smartMatchOption(directAnswer, options, label);
          if (matched) bestOption = matched;
        }
      }
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

      // Try pre-scraped answer first — smart deterministic matching
      let answer = '';
      const preAnswer = getPreScrapedAnswer('', legend);
      if (preAnswer) {
        const matched = smartMatchOption(preAnswer, radioLabels, legend);
        if (matched) {
          answer = matched;
          console.log(`    ✓ Pre-scraped match: "${legend}" → "${matched}"`);
        }
      }

      // Try saved rules first (user corrections override hardcoded defaults)
      if (!answer) {
        try {
          const ruleAnswer = await answerQuestion(legend, 'radio', radioLabels);
          if (ruleAnswer && !isRefusalText(ruleAnswer)) {
            const matched = smartMatchOption(ruleAnswer, radioLabels, legend);
            if (matched) answer = matched;
          }
        } catch {
          /* skip */
        }
      }

      // Try hardcoded profile answer as fallback
      if (!answer) {
        const directAnswer = getDirectAnswer('', legend, profile, 'radio');
        if (directAnswer) {
          const matched = smartMatchOption(directAnswer, radioLabels, legend);
          if (matched) answer = matched;
        }
      }
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

async function handleCoverLetterField(page: Page, job: ScoredJob): Promise<void> {
  console.log('    Checking for cover letter field...');

  // Find the cover letter section by its label, then find the "Enter manually" button within it
  const coverLetterSection = await page.$('#upload-label-cover_letter, [id*="cover_letter"]');
  if (!coverLetterSection) {
    console.log('    No cover letter section found');
    return;
  }

  // Find the "Enter manually" button near the cover letter section
  // Get all "Enter manually" buttons and click the one associated with cover letter
  const allEnterBtns = await page.$$('button:has-text("Enter manually")');
  console.log(`    Found ${allEnterBtns.length} "Enter manually" button(s)`);

  // Click the LAST one — Greenhouse shows resume first, then cover letter
  // So the second "Enter manually" is for cover letter
  let clickedBtn = false;
  if (allEnterBtns.length >= 2) {
    console.log('    Clicking "Enter manually" for cover letter (2nd button)...');
    await allEnterBtns[allEnterBtns.length - 1].click();
    clickedBtn = true;
  } else if (allEnterBtns.length === 1) {
    // Only one button — check if resume is already uploaded (file input has value)
    const resumeInput = await page.$('input[type="file"][id="resume"]');
    const resumeValue = resumeInput
      ? await resumeInput.evaluate((el: any) => el.files?.length > 0).catch(() => false)
      : false;
    if (resumeValue) {
      // Resume already uploaded, this button must be for cover letter
      console.log('    Clicking "Enter manually" for cover letter...');
      await allEnterBtns[0].click();
      clickedBtn = true;
    }
  }

  // Load existing cover letter (pre-scraped or from DB) — avoid regeneration
  let coverLetter = '';
  const { ApplicationFieldsModel } = await import('@job-agent/shared');
  const preFilled = (await ApplicationFieldsModel.findOne({ externalJobId: job.id })
    .lean()
    .catch(() => null)) as any;
  if (preFilled?.coverLetter) {
    coverLetter = preFilled.coverLetter;
  }
  if (!coverLetter) {
    const { CoverLetterModel } = await import('../db');
    const existing = await CoverLetterModel.findOne({ externalJobId: job.id })
      .sort({ generatedAt: -1 })
      .lean()
      .catch(() => null);
    if ((existing as any)?.content) coverLetter = (existing as any).content;
  }

  if (clickedBtn) {
    await sleep(800);
  }

  // Look for the textarea — try multiple selectors and retry once
  let coverLetterTextarea = await page.$(
    'textarea[id*="cover_letter"], textarea[name*="cover_letter"]',
  );

  if (!coverLetterTextarea && coverLetterSection) {
    const parent = await coverLetterSection.evaluateHandle(
      (el: Element) =>
        el.closest('.field, .upload-field, [class*="field"]') || el.parentElement?.parentElement,
    );
    if (parent) {
      coverLetterTextarea = await parent.$('textarea');
    }
  }

  // Retry — textarea may take a moment to render after button click
  if (!coverLetterTextarea && clickedBtn) {
    await sleep(500);
    coverLetterTextarea = await page.$(
      'textarea[id*="cover_letter"], textarea[name*="cover_letter"]',
    );
    if (!coverLetterTextarea) {
      // Try any textarea near cover letter section
      coverLetterTextarea = await page.$('[class*="cover"] textarea, [id*="cover"] textarea');
    }
  }

  if (!coverLetterTextarea) {
    console.log('    No cover letter textarea — using file upload');
    const fileUpload = await page.$('input[type="file"][id="cover_letter"]');
    if (fileUpload && coverLetter) {
      try {
        const tempDir = path.join(__dirname, '../../data/cover-letters');
        fs.mkdirSync(tempDir, { recursive: true });
        const filename = `${job.company.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-cover-letter.txt`;
        const filepath = path.join(tempDir, filename);
        fs.writeFileSync(filepath, coverLetter);
        await fileUpload.setInputFiles(filepath);
        if (!preFilled?.coverLetter) await saveCoverLetter(job.id, coverLetter);
        console.log(`    ✓ Cover letter uploaded as file (${coverLetter.length} chars)`);
      } catch (err) {
        console.log(`    Cover letter upload failed: ${(err as Error).message}`);
      }
    } else if (!coverLetter) {
      console.log('    No cover letter generated yet for this job — skipping upload');
    }
    return;
  }

  const existingText = await coverLetterTextarea.inputValue().catch(() => '');
  if (existingText) {
    console.log('    Cover letter already filled');
    return;
  }

  if (!coverLetter) {
    console.log('    No cover letter generated yet for this job — skipping');
    return;
  }

  // Fill it directly into the form
  await coverLetterTextarea.fill(coverLetter);
  console.log(`    ✓ Cover letter filled in form (${coverLetter.length} chars)`);

  // Save to database for the Cover Letters tab
  if (!preFilled?.coverLetter) await saveCoverLetter(job.id, coverLetter);
}

async function handleResumeUpload(page: Page): Promise<void> {
  // Target specifically the resume upload, not the cover letter one
  const fileInput = await page.$(
    'input[type="file"][id="resume"], input[type="file"][name*="resume"]',
  );
  if (!fileInput) return;

  const resumeDir = path.join(__dirname, '../../data/resume');
  let resumePath = '';

  // Find any PDF in the resume directory
  try {
    const files = fs.readdirSync(resumeDir).filter((f: string) => f.toLowerCase().endsWith('.pdf'));
    if (files.length > 0) {
      resumePath = path.join(resumeDir, files[0]);
    }
  } catch {
    /* dir doesn't exist */
  }

  if (!resumePath) {
    console.log('    No resume PDF found in data/resume/, skipping upload');
    return;
  }

  await fileInput.setInputFiles(resumePath);
  console.log('    Uploaded resume');
  await sleep(1000);
}

export async function applyViaGreenhouse(page: Page, job: ScoredJob, submit: boolean = false): Promise<ApplicationResult> {
  try {
    let targetUrl: string;

    if (job.source === 'ashby' && job.url.includes('ashbyhq.com')) {
      // Ashby: navigate directly to the application page
      targetUrl = job.url.endsWith('/application') ? job.url : `${job.url}/application`;
      console.log(`  Navigating to Ashby application: ${targetUrl}`);
    } else {
      // Greenhouse: build direct URL if possible
      const directUrl = getGreenhouseDirectUrl(job);
      targetUrl = directUrl || job.url;
      console.log(`  Navigating to: ${targetUrl}`);
    }

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    // If we landed on a company page (not Greenhouse/Ashby form), click Apply
    if (!page.url().includes('greenhouse.io') && !page.url().includes('/application')) {
      const applyBtn = await page.$(
        'a[href*="apply"], a[href*="#app"], a[href*="application"], a:has-text("Apply for this job"), a:has-text("Apply Now"), a:has-text("Apply"), button:has-text("Apply")',
      );
      if (applyBtn) {
        console.log('  Clicking Apply button...');
        await applyBtn.click();
        await sleep(1500);
      }

      // Check if the form is in an iframe
      const ghFrame = page.frames().find((f) => f.url().includes('greenhouse.io'));
      if (ghFrame) {
        console.log('  Found Greenhouse iframe — switching to it');
        const iframeUrl = ghFrame.url();
        await page.goto(iframeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(1000);
      }
    }

    // Wait for form — Greenhouse uses first_name, Ashby uses _systemfield_name or generic input
    const nameField = await page
      .waitForSelector(
        'input[id="first_name"], input[id="firstname"], input[name*="first_name"], input[name*="name"][type="text"], form input[type="text"]',
        {
          timeout: 15000,
        },
      )
      .catch(() => null);
    if (!nameField) {
      console.log('  No application form found');
      await page
        .screenshot({ path: path.join(__dirname, '../../data/debug-apply.png') })
        .catch(() => null);
      return { success: false, reason: 'No application form found on page' };
    }

    console.log('  Application form found');

    // ── Try "Autofill with MyGreenhouse" ──
    const autofillBtn = await page.$(
      'button:has-text("Autofill with"), button:has-text("MyGreenhouse"), button:has-text("Autofill")',
    );
    if (autofillBtn) {
      const btnText = await autofillBtn.textContent().catch(() => '');
      console.log(`  Found autofill button: "${btnText?.trim()}" — clicking...`);
      await autofillBtn.click();
      await sleep(1500);

      // Check if it triggered login or directly filled
      const firstNameValue = await page.$eval('#first_name', (el: any) => el.value).catch(() => '');
      if (firstNameValue) {
        console.log(`  ✓ Autofill worked — first name: "${firstNameValue}"`);
      } else {
        // May need login — wait for user
        console.log('  ⏸ Autofill may need login — waiting...');
        await page
          .waitForFunction(
            () => {
              const el = document.querySelector('#first_name') as HTMLInputElement;
              return el && el.value.length > 0;
            },
            { timeout: 60000 },
          )
          .catch(() => {
            console.log('  Autofill timed out — will fill manually');
          });
      }
      await sleep(500);
    } else {
      console.log('  No Autofill button found — filling manually...');
    }

    // Cover letters are pre-generated in phase4 before browser launch

    // Fill form — wrap in try/catch so errors don't kill the watch loop
    try {
      await handleResumeUpload(page);
      await handleCoverLetterField(page, job);
      console.log('  Filling form fields...');
      await fillFormFields(page, job);
    } catch (err) {
      console.log(`  ⚠ Form fill error (continuing to watch): ${(err as Error).message}`);
    }

    // Check for empty required fields
    try {
      const emptyRequired = await page.evaluate(() => {
        const empties: string[] = [];
        document.querySelectorAll('input, textarea, select').forEach((el: any) => {
          if (el.offsetParent === null) return; // hidden
          if (el.type === 'file' || el.type === 'hidden' || el.type === 'submit') return;
          if (el.role === 'combobox') return;
          const val = el.value?.trim() || '';
          if (!val) {
            const id = el.id || '';
            const label = el.getAttribute('aria-label') || id || el.name || '?';
            const tag = el.tagName?.toLowerCase() || '?';
            const role = el.role || '';
            const type = el.type || '';
            empties.push(
              `${label} [${tag}${type ? ':' + type : ''}${role ? ' role=' + role : ''}]`,
            );
          }
        });
        return empties;
      });

      if (emptyRequired.length > 0) {
        console.log(`  ⚠ ${emptyRequired.length} empty fields: ${emptyRequired.join(', ')}`);
      } else {
        console.log('  ✓ All visible fields filled');
      }
    } catch (err) {
      console.log(`  ⚠ Field check error (continuing): ${(err as Error).message}`);
    }

    // ── Auto-submit the form ──
    setFormPageUrl(page.url());

    // Capture answers before submitting
    try {
      await captureFormAnswers(page, job);
    } catch {
      /* skip */
    }

    // Click submit button — gated on the `submit` flag threaded through from the UI.
    // When `submit=false`, the form gets filled but we DO NOT click Submit. Instead
    // of returning immediately (which would close the tab and move to the next job),
    // we fall through to the watching loop below so the window stays open: the user
    // can review and manually submit, and we'll detect that submission or the tab
    // closing.
    const skipSubmit = !submit;
    if (skipSubmit) {
      console.log('  ✓ Form filled (submit disabled). Review mode — window stays open.');
      console.log('  Either click Submit manually to complete this application, or close the tab to move to the next job.');
      // Snapshot the final form state for diagnostics
      try {
        // Comprehensive snapshot: detects unfilled required fields (text, textarea, select, combobox, radio groups)
        const snapshotScript = `
          (() => {
            const results = [];
            const seen = new Set();
            // Check each visible form field
            document.querySelectorAll('input, textarea, select').forEach((el) => {
              if (el.offsetParent === null) return;
              if (el.type === 'file' || el.type === 'hidden' || el.type === 'submit') return;
              if (el.type === 'radio' || el.type === 'checkbox') return;
              // Skip phone country picker input (always empty, managed by widget)
              if (el.id === 'country' && el.type === 'text') return;
              const role = el.getAttribute('role');
              // For React Select combobox inputs — check outer shell for value-container--has-value
              if (role === 'combobox') {
                const shell = el.closest('[class*="select-shell"], [class*="select__container"], [class*="select__control"]');
                if (shell) {
                  const filledContainer = shell.querySelector('[class*="value-container"][class*="has-value"], [class*="value-container--has-value"]');
                  if (filledContainer && (filledContainer.textContent || '').trim()) return;
                  const sv = shell.querySelector('[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"]');
                  if (sv && (sv.textContent || '').trim()) return;
                  const hiddenInput = shell.querySelector('input[type="hidden"]');
                  if (hiddenInput && hiddenInput.value) return;
                }
              }
              const val = (el.value || '').trim();
              if (val) return;
              // For native <select>, check option:checked with non-empty value
              if (el.tagName === 'SELECT') {
                const checked = el.querySelector('option:checked');
                if (checked && checked.value) return;
              }
              // Get label
              const wrapper = el.closest('[class*="field"], [class*="Field"], .field, fieldset');
              let label = '';
              if (wrapper) {
                const labelEl = wrapper.querySelector('label, legend');
                label = labelEl ? (labelEl.textContent || '').trim() : '';
              }
              if (!label) label = el.getAttribute('aria-label') || '';
              if (!label) label = el.placeholder || '';
              const required = (label.includes('*') || el.required || el.getAttribute('aria-required') === 'true');
              const key = (el.id || '') + ':' + label.slice(0, 40);
              if (seen.has(key)) return;
              seen.add(key);
              results.push({
                id: el.id || '',
                tag: el.tagName + ':' + (el.type || role || ''),
                label: label.slice(0, 80),
                required,
              });
            });
            // Check radio groups that aren't selected
            const radioGroups = {};
            document.querySelectorAll('input[type="radio"]').forEach((el) => {
              const name = el.name || el.id;
              if (!name) return;
              if (!radioGroups[name]) radioGroups[name] = { any: el, checked: false };
              if (el.checked) radioGroups[name].checked = true;
            });
            for (const name in radioGroups) {
              if (radioGroups[name].checked) continue;
              const el = radioGroups[name].any;
              let node = el.parentElement;
              let label = '';
              for (let i = 0; i < 10 && node; i++) {
                const legend = node.querySelector('legend');
                if (legend) { label = (legend.textContent || '').trim(); break; }
                const labels = node.querySelectorAll(':scope > label');
                let found = false;
                for (const l of Array.from(labels)) {
                  if (!l.querySelector('input')) { label = (l.textContent || '').trim(); found = true; break; }
                }
                if (found) break;
                node = node.parentElement;
              }
              // Skip garbage phone radio groups
              if (label === 'Phone' || label === 'Country') continue;
              const required = label.includes('*');
              results.push({ id: name, tag: 'RADIO_GROUP', label: label.slice(0, 80), required });
            }
            // Check checkbox groups that aren't selected (multi-select questions)
            const checkboxGroups = {};
            document.querySelectorAll('input[type="checkbox"]').forEach((el) => {
              const name = el.name || el.id;
              if (!name) return;
              if (!checkboxGroups[name]) checkboxGroups[name] = { any: el, anyChecked: false };
              if (el.checked) checkboxGroups[name].anyChecked = true;
            });
            for (const name in checkboxGroups) {
              if (checkboxGroups[name].anyChecked) continue;
              const el = checkboxGroups[name].any;
              const wrapper = el.closest('fieldset, [class*="field"], [class*="Field"]');
              const labelEl = wrapper ? wrapper.querySelector('label, legend') : null;
              const label = labelEl ? (labelEl.textContent || '').trim() : '';
              const required = label.includes('*') || (wrapper && (wrapper.querySelector('[class*="required"], [aria-required="true"]') !== null));
              results.push({ id: name, tag: 'CHECKBOX_GROUP', label: label.slice(0, 80), required });
            }
            return results;
          })()`;
        const unfilled = (await page.evaluate(snapshotScript).catch(() => [])) as any[];
        console.log(`  === UNFILLED FIELDS (${unfilled.length}) ===`);
        for (const f of unfilled) {
          console.log(`    ${f.required ? '[REQ]' : '[opt]'} ${f.tag} "${f.label}" id=${f.id}`);
        }
      } catch {}
      // fall through to watching loop — no return, no submit click.
    } else {
      const submitBtn = await page.$(
        'form button[type="submit"], button:has-text("Submit Application"), button:has-text("Submit")',
      );
      if (submitBtn) {
        console.log('  Clicking Submit...');
        await submitBtn.click();
        await sleep(3000);

        const success = await detectSubmissionSuccess(page);
        if (success) {
          console.log('  ✓ Application submitted successfully!');
          return { success: true, method: 'greenhouse' };
        }
        console.log('  Submit clicked — waiting for confirmation...');
      } else {
        console.log('  No submit button found — watching for manual submission...');
      }
    }

    console.log('  (Watching for submission confirmation...)');

    const maxWait = 30 * 60 * 1000;
    const start = Date.now();
    let pollCount = 0;
    let answersCaptured = false;

    while (Date.now() - start < maxWait) {
      await sleep(3000);
      pollCount++;

      try {
        // Detect if page/browser was closed
        if (page.isClosed()) {
          console.log('  Page closed by user. Moving to next job.');
          return { success: false, reason: 'Page closed by user' };
        }

        const currentUrl = page.url();
        if (!currentUrl || currentUrl === 'about:blank') continue;

        // Check for submission
        const pageSuccess = await detectSubmissionSuccess(page);
        if (pageSuccess) {
          console.log('  ✓ Submission detected!');
          console.log('  Waiting 15s for verification code...');
          await sleep(15000);
          return { success: true, method: 'greenhouse' };
        }

        // Capture answers ONCE when form is still visible (just before user submits)
        // Overwrite previous capture, don't append
        if (!answersCaptured) {
          const formExists = await page
            .$('input[id="first_name"], form button[type="submit"]')
            .catch(() => null);
          if (formExists) {
            // Wait 30s before first capture — let user fill fields
            if (Date.now() - start > 30000) {
              await captureFormAnswers(page, job);
              answersCaptured = true;
            }
          }
        }

        // Log every 30 polls (~90s)
        if (pollCount % 30 === 0) {
          const elapsed = Math.round((Date.now() - start) / 60000);
          console.log(`  ... still watching (${elapsed} min elapsed)`);
          // Re-capture in case user filled more fields
          const formExists = await page.$('form button[type="submit"]').catch(() => null);
          if (formExists) {
            await captureFormAnswers(page, job);
          }
        }
      } catch (err) {
        const msg = (err as Error).message || '';
        if (msg.includes('closed') || msg.includes('destroyed') || msg.includes('disposed')) {
          console.log('  Page/browser closed. Moving to next job.');
          return { success: false, reason: 'Page closed by user' };
        }
        console.log(`  Watch error (continuing): ${msg}`);
      }
    }

    // Timed out
    console.log('  ⏰ Timed out (30 min). Moving to next job.');
    return { success: false, reason: 'Timed out waiting for submission' };
  } catch (err) {
    console.log(`  ✗ CRITICAL ERROR — this is why the browser closed: ${(err as Error).message}`);
    console.log(`  Stack: ${(err as Error).stack?.slice(0, 300)}`);
    await page
      .screenshot({ path: path.join(__dirname, '../../data/debug-greenhouse-apply.png') })
      .catch(() => null);
    return { success: false, reason: (err as Error).message };
  }
}
