import { Injectable } from '@nestjs/common';

@Injectable()
export class OptionMatcherService {
  // Smart matcher: maps a short answer (e.g. "United States", "Female", "No") to the best dropdown option
  // without LLM — handles common variations deterministically
  smartMatchOption(answer: string, options: string[], label: string): string | null {
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
}
