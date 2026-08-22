import { Inject, Injectable } from '@nestjs/common';
import { Page } from 'playwright';
import axios from 'axios';
import { QuestionAnswererService } from '../answer-resolution/question-answerer.service';
import { logQuestionAnswer } from '../persistence/db';
import type { ScoredJob } from '../types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const API_URL = process.env.API_URL || 'http://localhost:3001/api';

async function getFieldLabel(page: Page, element: any): Promise<string> {
  try {
    const ariaLabel = await element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;

    const id = await element.getAttribute('id');
    if (id) {
      const label = await page
        .$eval(`label[for="${id}"]`, (el: Element) => el.textContent?.trim() ?? '')
        .catch(() => '');
      if (label) return label;
    }

    const parentLabel = await element
      .evaluate((el: Element) => {
        const label = el.closest('label');
        return label?.textContent?.trim() ?? '';
      })
      .catch(() => '');

    return parentLabel;
  } catch {
    return '';
  }
}

@Injectable()
export class FormHandlerService {
  constructor(@Inject(QuestionAnswererService) private readonly questionAnswerer: QuestionAnswererService) {}

  // Tries rule-based → LLM → if both fail or answer is empty, posts to API and waits for user.
  async answerQuestionWithPause(
    question: string,
    type: 'text' | 'textarea' | 'select' | 'radio',
    job: ScoredJob,
    options?: string[],
  ): Promise<string> {
    this.questionAnswerer.setCurrentJob({ id: job.id, title: job.title, company: job.company });

    // For select/radio — try rule-based match only, skip LLM (it generates paragraphs)
    // For text/textarea — try rule-based, then LLM
    try {
      const answer = await this.questionAnswerer.answerQuestion(question, type, options);
      if (answer && answer.length > 0) {
        // For select/radio, verify the answer matches an option
        if ((type === 'select' || type === 'radio') && options?.length) {
          const match = options.find(
            (o) =>
              o.toLowerCase() === answer.toLowerCase() ||
              o.toLowerCase().includes(answer.toLowerCase()) ||
              answer.toLowerCase().includes(o.toLowerCase()),
          );
          if (match) {
            return match;
          }
        } else {
          return answer;
        }
      }
    } catch {
      // Fall through to pause-and-ask
    }

    // Post to API and wait for user answer
    const displayQuestion = options?.length
      ? `"${question}" — pick one of the options`
      : `"${question}" — type your answer`;
    console.log(`    ⏸ Waiting for user answer: ${displayQuestion}`);

    try {
      const { data: pending } = await axios.post(`${API_URL}/form-answers/pending`, {
        jobTitle: job.title,
        company: job.company,
        question,
        type,
        options,
      });

      const maxWait = 5 * 60 * 1000; // 5 min timeout
      const start = Date.now();

      while (Date.now() - start < maxWait) {
        await sleep(2000);

        const { data: q } = await axios.get(`${API_URL}/form-answers/pending/${pending.id}`);
        if (q?.answer) {
          if (q.answer === '__SKIP__') {
            console.log(`    ⏭ User skipped this question`);
            return '';
          }
          console.log(`    ✓ User answered: "${q.answer}"`);
          const isInternal =
            question.toLowerCase().includes('review the form') ||
            question.toLowerCase().includes('cover letter for') ||
            question.toLowerCase().includes('bot will detect');
          if (!isInternal) {
            await logQuestionAnswer(job.id, job.title, job.company, {
              question,
              type,
              options,
              answer: q.answer,
              source: 'rule' as const,
            }).catch(() => {});
          }
          return q.answer;
        }
      }
      console.log(`⏰ Timed out waiting for answer`);
    } catch (err) {
      console.log(`Failed to post pending question: ${(err as Error).message}`);
    }
    return '';
  }

  async fillTextInputs(page: Page): Promise<void> {
    const inputs = await page.$$(
      '.jobs-easy-apply-form-element input[type="text"]:not([readonly]), ' +
        '.jobs-easy-apply-form-element input[type="tel"], ' +
        '.jobs-easy-apply-form-element input[type="email"], ' +
        '.jobs-easy-apply-form-element input[type="number"]',
    );

    for (const input of inputs) {
      const label = await getFieldLabel(page, input);
      if (!label) continue;

      const existing = await input.inputValue().catch(() => '');
      if (existing) {
        console.log(`    Pre-filled: "${label}" = "${existing}"`);
        continue;
      }

      const answer = await this.questionAnswerer.answerQuestion(label, 'text');
      if (answer) {
        await input.fill(answer);
        await sleep(300);
        console.log(`    Filled: "${label}" = "${answer}"`);
      }
    }
  }

  async fillTextareas(page: Page): Promise<void> {
    const textareas = await page.$$('.jobs-easy-apply-form-element textarea');

    for (const textarea of textareas) {
      const label = await getFieldLabel(page, textarea);
      if (!label) continue;

      const existing = await textarea.inputValue().catch(() => '');
      if (existing) continue;

      const answer = await this.questionAnswerer.answerQuestion(label, 'textarea');
      if (answer) {
        await textarea.fill(answer);
        await sleep(300);
        console.log(`    Filled textarea: "${label}"`);
      }
    }
  }

  async fillSelects(page: Page): Promise<void> {
    const selects = await page.$$('.jobs-easy-apply-form-element select');

    for (const select of selects) {
      const label = await getFieldLabel(page, select);
      if (!label) continue;

      const options = await select.$$eval('option:not([value=""])', (opts: Element[]) =>
        opts.map((o) => (o as HTMLOptionElement).text),
      );

      if (!options.length) continue;

      const answer = await this.questionAnswerer.answerQuestion(label, 'select', options);
      const bestOption =
        options.find(
          (o) =>
            o.toLowerCase().includes(answer.toLowerCase()) ||
            answer.toLowerCase().includes(o.toLowerCase()),
        ) ?? options[0];

      await select.selectOption({ label: bestOption });
      console.log(`    Select: "${label}" → "${bestOption}"`);
      await sleep(300);
    }
  }

  async fillRadios(page: Page): Promise<void> {
    const groups = await page.$$('.jobs-easy-apply-form-element fieldset');

    for (const group of groups) {
      const legend = await group
        .$eval('legend', (el: Element) => el.textContent?.trim() ?? '')
        .catch(() => '');

      if (!legend) continue;

      const radioLabels = await group.$$eval('label', (labels: Element[]) =>
        labels.map((l) => l.textContent?.trim() ?? ''),
      );

      const answer = await this.questionAnswerer.answerQuestion(legend, 'radio', radioLabels);

      const radios = await group.$$('input[type="radio"]');
      for (const radio of radios) {
        const radioId = await radio.getAttribute('id');
        if (!radioId) continue;

        const radioLabel = await page
          .$eval(`label[for="${radioId}"]`, (el: Element) => el.textContent?.trim() ?? '')
          .catch(() => '');

        if (radioLabel.toLowerCase().includes(answer.toLowerCase())) {
          await radio.click();
          console.log(`    Radio: "${legend}" → "${radioLabel}"`);
          break;
        }
      }
      await sleep(300);
    }
  }

  async handleFormFields(page: Page): Promise<void> {
    await this.fillTextInputs(page);
    await this.fillTextareas(page);
    await this.fillSelects(page);
    await this.fillRadios(page);
  }
}
