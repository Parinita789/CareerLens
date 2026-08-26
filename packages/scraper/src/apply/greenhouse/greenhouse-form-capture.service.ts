import { Inject, Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import { logQuestionAnswer, ProfileAnswerModel } from '../../persistence/db';
import { QuestionAnswererService } from '../../answer-resolution/question-answerer.service';
import type { ScoredJob } from '../../types';

@Injectable()
export class GreenhouseFormCaptureService {
  constructor(@Inject(QuestionAnswererService) private readonly questionAnswerer: QuestionAnswererService) {}

  // Capture all form field values and save as Q&A log
  async captureFormAnswers(page: Page, job: ScoredJob): Promise<void> {
    try {
      const fields = await page.evaluate(() => {
        const results: { label: string; value: string; type: string }[] = [];

        document.querySelectorAll('input, textarea, select').forEach((el: any) => {
          if (el.offsetParent === null) return;
          if (
            el.type === 'file' ||
            el.type === 'hidden' ||
            el.type === 'submit' ||
            el.type === 'password' ||
            // Radios and checkboxes are handled by the dedicated passes below,
            // which read the question from the enclosing fieldset's legend. Left
            // in this sweep, each *option* was captured as its own question with
            // el.value — which for an input with no value attribute is the
            // browser default "on". That is where rules like
            // "asian (not hispanic or latino)" -> "on" came from.
            el.type === 'radio' ||
            el.type === 'checkbox'
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

        // Capture checked checkboxes. Grouped ones (a multi-select question such
        // as race/ethnicity) must be recorded as ONE question keyed on the
        // fieldset's legend, with the ticked options joined — recording each
        // option label as its own question is what produced rules like
        // "two or more races (not hispanic or latino)" -> "Yes".
        // A checkbox with no fieldset is a standalone consent-style question, so
        // there its own label genuinely is the question.
        const checkedByGroup: Record<string, string[]> = {};
        document.querySelectorAll('input[type="checkbox"]:checked').forEach((el: any) => {
          const labelEl = document.querySelector('label[for="' + el.id + '"]');
          const label = labelEl?.textContent?.trim() || el.id?.replace(/[_-]/g, ' ') || '';
          if (!label) return;
          const legend = el.closest('fieldset')?.querySelector('legend')?.textContent?.trim() || '';
          if (legend) {
            (checkedByGroup[legend] ||= []).push(label);
          } else {
            results.push({ label, value: 'Yes', type: 'checkbox' });
          }
        });
        for (const legend in checkedByGroup) {
          results.push({
            label: legend,
            value: checkedByGroup[legend].join(', '),
            type: 'checkbox',
          });
        }

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
      this.questionAnswerer.clearRulesCache();
    } catch (err) {
      console.log(`  Failed to capture form answers: ${(err as Error).message}`);
    }
  }
}
