import { loadProfile, loadAnswerRules } from '../persistence/db';
import { llmChat } from '@job-agent/shared';
import { ProfileAnswerModel } from '@job-agent/shared';
import type { ScoredJob } from '../types';

interface ScrapedField {
  label: string;
  type: string;
  value: string;
  source: 'profile' | 'rule' | 'llm' | 'unknown';
  options: string[];
  fieldId: string;
  required: boolean;
}

export function getProfileAnswer(label: string, profile: any, jobCompany?: string): string | null {
  const l = label.toLowerCase();

  // ── Identity ──
  if (l === 'first name') return profile?.personal?.name?.split(' ')[0] || null;
  if (l === 'last name' || l === 'surname')
    return profile?.personal?.name?.split(' ').slice(1).join(' ') || null;
  if (l === 'name' || l === 'full name') return profile?.personal?.name || null;
  if (l.includes('preferred')) return profile?.personal?.name?.split(' ')[0] || null;
  if (l === 'email' || l === 'email address') return profile?.personal?.email || null;
  if (l === 'phone' || l === 'phone number') return profile?.personal?.phone || null;
  if (l.includes('linkedin') && !l.includes('other')) return profile?.personal?.linkedin || null;
  if (l === 'github' || l === 'github url' || l === 'github profile')
    return profile?.personal?.github || null;
  if (l === 'website' || l === 'personal website') return profile?.personal?.github || null;
  // Leave optional link fields empty — don't guess
  if (
    l.includes('twitter') ||
    l.includes('portfolio') ||
    l.includes('other link') ||
    l.includes('other url') ||
    l.includes('additional link')
  )
    return '';

  // ── Yes/No questions (MUST come before location/country to avoid false matches) ──
  if (
    l.includes('authorized to work') ||
    l.includes('eligible to work') ||
    l.includes('work legally') ||
    l.includes('work authorization') ||
    l.includes('are you authorized')
  )
    return 'Yes';
  if (
    l.includes('sponsorship') ||
    l.includes('visa status') ||
    l.includes('sponsor you') ||
    (l.includes('require') && l.includes('sponsor')) ||
    (l.includes('require') && l.includes('work permit'))
  )
    return 'No';
  if (l.includes('willing to relocate') || l.includes('open to relocation')) return 'Yes';
  if (l.includes('background check') || l.includes('drug test')) return 'Yes';
  if (
    l.includes('remote') &&
    (l.includes('plan to') || l.includes('do you') || l.includes('intend'))
  )
    return 'Yes';
  if (
    l.includes('commute') ||
    l.includes('in person') ||
    l.includes('hybrid') ||
    l.includes('onsite') ||
    l.includes('on-site')
  )
    return 'Yes';
  // "Have you worked for X" / "employed by X" — check work history from resume
  if (
    l.includes('employed by') ||
    l.includes('previously worked') ||
    l.includes('worked at') ||
    l.includes('worked for') ||
    l.includes('have you ever been employed') ||
    l.includes('have you ever worked')
  ) {
    const companies = (profile?.work_history || []).map((w: any) =>
      (w.company || '').toLowerCase(),
    );
    // Extract company name from the question — check if it matches any past employer
    const questionCompany = jobCompany?.toLowerCase() || '';
    const workedThere = companies.some(
      (c: string) =>
        l.includes(c) ||
        (questionCompany && c.includes(questionCompany)) ||
        (questionCompany && questionCompany.includes(c)),
    );
    return workedThere ? 'Yes' : 'No';
  }
  if (l.includes('opt-in') || l.includes('opt in') || l.includes('whatsapp')) return 'Yes';
  if (
    l.includes('consent') ||
    l.includes('checking this box') ||
    l.includes('by checking') ||
    l.includes('i agree') ||
    l.includes('i acknowledge')
  )
    return 'Yes';
  if (l.includes('hispanic') || l.includes('latino')) return 'No';

  // ── Demographics ──
  if (l.includes('transgender')) return 'No';
  if (l.includes('gender') && l.includes('identify')) return 'Woman';
  if (l.includes('gender')) return 'Female';
  if (
    l.includes('identify as') &&
    !l.includes('race') &&
    !l.includes('ethnicity') &&
    !l.includes('veteran') &&
    !l.includes('disability') &&
    !l.includes('orientation')
  )
    return 'Cisgender';
  if (l.includes('race') || l.includes('ethnicity')) return 'Asian';
  if (l.includes('veteran')) return 'No';
  if (l.includes('disability')) return 'No';
  if (l.includes('sexual orientation')) return 'Heterosexual';
  if (l.includes('pronoun')) return 'She/Her';
  if (l.includes('first-generation') || l.includes('first generation')) return 'No';

  // ── Location (after yes/no questions to avoid "location" keyword conflicts) ──
  if (l.includes('country') && !l.includes('city')) return 'United States';
  if (
    l.includes('city') ||
    (l.includes('location') &&
      !l.includes('authorized') &&
      !l.includes('sponsor') &&
      !l.includes('remote') &&
      !l.includes('require') &&
      !l.includes('selected'))
  ) {
    // Return just city, state (no country) for better dropdown matching
    const loc = profile?.preferences?.location?.current_city || profile?.personal?.location || null;
    if (loc) return loc.replace(/, USA$/, '').replace(/, United States$/, '');
    return null;
  }
  if (l.includes('state') || l.includes('province')) return 'California';
  if (l.includes('zip') || l.includes('postal')) return '95134';

  // ── Work ──
  if (l.includes('salary') || l.includes('compensation'))
    return String(profile?.compensation?.base_salary_preferred || 180000);
  if (l.includes('years of experience') || l.includes('total experience'))
    return String(profile?.experience?.total_years || 7);
  if (l.includes('current title') || l.includes('job title'))
    return profile?.experience?.current_level || null;
  if (l.includes('employment type')) return 'Full-time';
  if (l.includes('start date') || l.includes('notice period')) return '2 weeks';
  if (l.includes('how did you hear') || l.includes('referral source')) return 'LinkedIn';

  // ── Education ──
  if (l.includes('degree') || l.includes('education')) return "Bachelor's";
  if (l.includes('university') || l.includes('school') || l.includes('college'))
    return 'Chandigarh University';
  if (l.includes('major') || l.includes('field of study')) return 'Computer Science';
  if (l.includes('graduation') || l.includes('year of completion')) return '2018';

  return null;
}

export function matchRule(label: string, rules: Record<string, string>): string | null {
  const normalized = label
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [pattern, answer] of Object.entries(rules)) {
    if (normalized.includes(pattern.toLowerCase())) return answer;
  }
  return null;
}

export function matchOption(answer: string, options: string[]): string | null {
  if (options.length === 0) return answer;
  const a = answer.toLowerCase().trim();

  // Exact match
  const exact = options.find((o) => o.toLowerCase().trim() === a);
  if (exact) return exact;

  // Race: "Asian" → prefer "South Asian", then exact "Asian"
  if (a === 'asian' || a === 'south asian') {
    return (
      options.find((o) => o.toLowerCase().includes('south asian')) ||
      options.find(
        (o) => o.toLowerCase().trim() === 'asian' || o.toLowerCase().startsWith('asian'),
      ) ||
      null
    );
  }

  // Gender: "Female" ↔ "Woman"
  if (a === 'female' || a === 'woman') {
    return (
      options.find(
        (o) => o.toLowerCase().includes('female') || o.toLowerCase().includes('woman'),
      ) || null
    );
  }

  // Gender identity / Sexual orientation: "Cisgender" ↔ "Straight" ↔ "Heterosexual"
  if (a === 'heterosexual' || a === 'straight' || a === 'cisgender') {
    return (
      options.find((o) => o.toLowerCase().includes('cisgender')) ||
      options.find((o) => o.toLowerCase().includes('heterosexual')) ||
      options.find((o) => o.toLowerCase().includes('straight')) ||
      null
    );
  }

  // Contains match (both directions)
  const contains = options.find((o) => {
    const ol = o.toLowerCase();
    return (ol.includes(a) || a.includes(ol)) && !o.includes('+');
  });
  if (contains) return contains;

  // Country aliases: "United States" ↔ "US" ↔ "USA"
  if (a === 'united states' || a === 'us' || a === 'usa') {
    const match = options.find((o) => {
      const ol = o.toLowerCase().trim();
      return (
        ol === 'us' ||
        ol === 'usa' ||
        ol.includes('united states') ||
        ol === 'u.s.' ||
        ol === 'u.s.a.'
      );
    });
    if (match) return match;
  }

  // Yes/No → match options starting with Yes/No or containing positive/negative phrases
  if (a === 'yes') {
    return (
      options.find((o) => o.toLowerCase().startsWith('yes')) ||
      options.find((o) => {
        const ol = o.toLowerCase();
        return (
          (ol.includes('i am') ||
            ol.includes('i do') ||
            ol.includes('i will') ||
            ol.includes('i intend')) &&
          !ol.includes('not')
        );
      }) ||
      null
    );
  }
  if (a === 'no') {
    return (
      options.find((o) => o.toLowerCase().startsWith('no')) ||
      options.find((o) => {
        const ol = o.toLowerCase();
        return (
          ol.includes('i am not') ||
          ol.includes('i do not') ||
          ol.includes('i will not') ||
          ol.includes('not a') ||
          ol.includes('do not have')
        );
      }) ||
      null
    );
  }

  // Starts-with
  const starts = options.find((o) => o.toLowerCase().startsWith(a));
  if (starts) return starts;

  return null;
}

// Heuristic: does this look like an LLM refusal / non-answer we shouldn't auto-submit?
function isRefusal(text: string): boolean {
  if (!text) return true;
  const t = text.trim().toLowerCase();
  if (t.length < 2) return true;
  if (t.length > 400) return true; // LLM explanatory ramble — too long for a form answer
  const refusalMarkers = [
    "i can't answer",
    'i cannot answer',
    "i don't wish to",
    'the candidate should',
    'candidate needs to',
    'candidate themselves',
    'i decline to',
    "i shouldn't guess",
    'prefer not to say',
    "i'm not able to",
    'i am not able to',
    'this is personal',
    'sensitive personal',
    'only the candidate',
    'inferred from',
    'not included in',
    'not something that',
  ];
  return refusalMarkers.some((m) => t.includes(m));
}

export async function preAnswerFields(
  fields: ScrapedField[],
  job: ScoredJob,
): Promise<ScrapedField[]> {
  const profile = await loadProfile();
  const rules = await loadAnswerRules();

  for (const field of fields) {
    if (field.type === 'file') {
      field.value = field.label.toLowerCase().includes('resume') ? 'Resume uploaded' : '';
      field.source = field.value ? 'profile' : 'unknown';
      continue;
    }

    // 1. Try saved rules FIRST (user corrections take priority over hardcoded defaults)
    const ruleAnswer = matchRule(field.label, rules);
    if (ruleAnswer) {
      if (field.options.length > 0) {
        const matched = matchOption(ruleAnswer, field.options);
        if (matched) {
          field.value = matched;
          field.source = 'rule';
          continue;
        }
      } else {
        field.value = ruleAnswer;
        field.source = 'rule';
        continue;
      }
    }

    // 2. Try profile defaults
    const profileAnswer = getProfileAnswer(field.label, profile, job.company);
    if (profileAnswer) {
      if (field.options.length > 0) {
        const matched = matchOption(profileAnswer, field.options);
        if (matched) {
          field.value = matched;
          field.source = 'profile';
          continue;
        }
      } else {
        field.value = profileAnswer;
        field.source = 'profile';
        continue;
      }
    }

    // 3. Try LLM for non-dropdown fields
    const candidateInfo = `Candidate: ${profile?.personal?.name || 'Parinita Kumari'}, Female, located in ${profile?.preferences?.location?.current_city || 'Fremont, CA'}, USA. Backend Engineer, ${profile?.experience?.total_years || 7} years, TypeScript/Node.js. Authorized to work in US, no sponsorship needed. AI/Side project: Built JobPilot (https://github.com/Parinita789/job-agent) — an AI-powered job hunting automation platform using TypeScript, Node.js, Playwright, MongoDB, NestJS, React. Scrapes jobs from LinkedIn/Greenhouse/Ashby, scores with Claude, pre-fills application forms, auto-applies.`;
    if (field.type === 'text' || field.type === 'textarea') {
      try {
        const prompt =
          field.type === 'textarea'
            ? `Answer this job application question in 2-3 sentences.\nQuestion: "${field.label}"\nJob: ${job.title} at ${job.company}\n${candidateInfo}\nAnswer directly.`
            : `Answer this field concisely (under 100 chars).\nField: "${field.label}"\nJob: ${job.title} at ${job.company}\n${candidateInfo}\nReply with ONLY the answer.`;
        const answer = await llmChat(prompt, { maxTokens: field.type === 'textarea' ? 200 : 50 });
        if (answer && answer.length > 0 && !isRefusal(answer)) {
          field.value = answer;
          field.source = 'llm';
          continue;
        }
      } catch {
        /* skip */
      }
    }

    // 4. Try LLM for dropdowns with options
    if (
      (field.type === 'select' || field.type === 'radio' || field.type === 'combobox') &&
      field.options.length > 0 &&
      field.options.length <= 50
    ) {
      try {
        const prompt = `Pick the best option for: "${field.label}"\nOptions: ${field.options.join(', ')}\n${candidateInfo}\nReply with ONLY the exact option text.`;
        const answer = await llmChat(prompt, { maxTokens: 50 });
        if (answer && !isRefusal(answer)) {
          const matched = matchOption(answer, field.options);
          if (matched) {
            field.value = matched;
            field.source = 'llm';
            continue;
          }
        }
      } catch {
        /* skip */
      }
    }

    // 5. Unknown
    field.source = 'unknown';
  }

  return fields;
}
