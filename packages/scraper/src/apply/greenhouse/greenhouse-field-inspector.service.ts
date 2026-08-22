import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';

@Injectable()
export class GreenhouseFieldInspectorService {
  async getFieldLabel(element: any, page: Page): Promise<string> {
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
}
