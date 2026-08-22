import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';

@Injectable()
export class GreenhouseSubmissionWatcherService {
  private formPageUrl = '';

  setFormPageUrl(url: string): void {
    this.formPageUrl = url;
  }

  async detectSubmissionSuccess(page: Page): Promise<boolean> {
    try {
      const currentUrl = page.url();

      // Must still be on a greenhouse-related page
      if (!currentUrl.includes('greenhouse') && !currentUrl.includes(this.formPageUrl)) return false;

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
}
