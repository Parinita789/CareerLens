import { Inject, Injectable } from '@nestjs/common';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { llmChat, ProfileAnswerModel } from '@job-agent/shared';
import { loadProfile, loadAnswerRules, logQuestionAnswer } from '../persistence/db';
import { OptionMatcherService } from './option-matcher.service';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '../../../../.env') });

// Default rules — used as fallback if DB has no rules
const DEFAULT_RULES: Record<string, string> = {
  'authorized to work': 'Yes',
  'legally authorized': 'Yes',
  'visa sponsorship': 'No',
  'require sponsorship': 'No',
  'years of experience': '7',
  'how many years': '7',
  'expected salary': '180000',
  'desired salary': '180000',
  'salary expectation': '180000',
  'current salary': '160000',
  'start date': '2 weeks',
  'when can you start': '2 weeks',
  remote: 'Yes',
  'willing to relocate': 'Yes',
  city: 'Fremont',
  state: 'California',
  country: 'United States',
};

function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Q&A logging ──
interface QAEntry {
  question: string;
  type: string;
  options?: string[];
  answer: string;
  source: 'rule' | 'llm';
}

async function askLLM(prompt: string): Promise<string> {
  return llmChat(prompt, { temperature: 0.1, maxTokens: 200 });
}

// Demographics block for the LLM prompt. Falls back to "decline to answer"
// hints when a field isn't set, so the LLM knows the user prefers not to
// disclose rather than inventing an answer.
function demographicsBlock(profile: any): string {
  const d = profile?.demographics ?? {};
  const yn = (v: boolean | undefined) =>
    v === true ? 'Yes' : v === false ? 'No' : 'decline to answer';
  const str = (v: string | undefined) => (v && v.length > 0 ? v : 'decline to answer');
  return [
    `- Race/ethnicity: ${str(d.race)}`,
    `- Hispanic or Latino: ${yn(d.hispanic_or_latino)}`,
    `- Gender: ${str(d.gender)}`,
    `- Pronouns: ${str(d.pronouns)}`,
    `- Has disability: ${yn(d.disability)}`,
    `- Veteran: ${yn(d.veteran)}`,
    `- Transgender: ${yn(d.transgender)}`,
    `- Sexual orientation: ${str(d.sexual_orientation)}`,
    `- US citizen or permanent resident: ${yn(d.citizen_or_permanent_resident)}`,
  ].join('\n');
}

const SAVED_ANSWERS_PROMPT_CAP = 30;

function tokenize(s: string): string[] {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

async function savedAnswersBlock(question: string): Promise<string> {
  const rules = await ProfileAnswerModel.find().lean();
  if (rules.length === 0) return '(none)';

  if (rules.length <= SAVED_ANSWERS_PROMPT_CAP) {
    return rules.map((r: any) => `- "${r.question_pattern}": ${r.answer}`).join('\n');
  }

  const qTokens = new Set(tokenize(question));
  const scored = rules.map((r: any) => {
    const ruleTokens = tokenize(`${r.question_pattern} ${r.answer}`);
    let overlap = 0;
    for (const t of ruleTokens) if (qTokens.has(t)) overlap++;
    return { rule: r, score: overlap, len: (r.question_pattern ?? '').length };
  });
  scored.sort((a, b) => b.score - a.score || b.len - a.len);
  const top = scored.slice(0, SAVED_ANSWERS_PROMPT_CAP);
  return top.map((s) => `- "${s.rule.question_pattern}": ${s.rule.answer}`).join('\n');
}

@Injectable()
export class QuestionAnswererService {
  private profile: any = null;
  private rules: Record<string, string> | null = null;
  private currentJob: { id: string; title: string; company: string } | null = null;

  constructor(@Inject(OptionMatcherService) private readonly optionMatcher: OptionMatcherService) {}

  clearRulesCache(): void {
    this.rules = null;
  }

  setCurrentJob(job: { id: string; title: string; company: string }): void {
    this.currentJob = job;
  }

  /**
   * Forget which job is being applied to. This service is a process-wide
   * singleton and auto-apply applies every job in one process, so a job left set
   * after its application ends would silently claim the next one's answers.
   */
  clearCurrentJob(): void {
    this.currentJob = null;
  }

  private async getProfile(): Promise<any> {
    if (!this.profile) {
      this.profile = await loadProfile();
    }
    return this.profile;
  }

  private async getRules(): Promise<Record<string, string>> {
    if (!this.rules) {
      const dbRules = await loadAnswerRules();
      this.rules = { ...DEFAULT_RULES, ...dbRules };
      // Merge profile-specific defaults lazily
      const profile = await this.getProfile();
      if (profile?.personal) {
        if (profile.personal.phone) this.rules.phone = profile.personal.phone;
        if (profile.personal.linkedin) this.rules.linkedin = profile.personal.linkedin;
        if (profile.personal.github) {
          this.rules.github = profile.personal.github;
          this.rules.website = profile.personal.github;
        }
      }
    }
    return this.rules;
  }

  private async matchStructured(question: string): Promise<string | null> {
    // Always reload rules to pick up newly saved answers
    this.rules = null;
    const q = normalizeQuestion(question);
    const rules = await this.getRules();
    // Prefer longer keywords (more specific) first to avoid "city" matching before "current city".
    const entries = Object.entries(rules).sort((a, b) => b[0].length - a[0].length);
    for (const [keyword, answer] of entries) {
      const k = normalizeQuestion(keyword);
      if (!k) continue;
      // Word-boundary match — prevents "city" matching inside "ethnicity", "state" inside "States".
      const re = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`);
      if (re.test(q)) return answer;
    }
    return null;
  }

  private async logQA(entry: QAEntry): Promise<void> {
    if (!this.currentJob) return;
    await logQuestionAnswer(this.currentJob.id, this.currentJob.title, this.currentJob.company, entry);
  }

  /**
   * Saved-rule lookup only — free, deterministic, and never calls a model. Returns
   * null when no rule matches so a caller can fall through to a cheaper or more
   * authoritative source without paying for a model call. `answerQuestion` is this
   * followed by `answerWithLlm`; split apart so the field resolver can consult saved
   * rules on every field while keeping LLM use to the call sites that already had it.
   */
  async matchSavedRule(
    question: string,
    type: 'text' | 'textarea' | 'select' | 'radio',
    options?: string[],
  ): Promise<string | null> {
    // A keyword rule can't stand in for open prose.
    if (type === 'textarea') return null;
    const structured = await this.matchStructured(question);
    if (!structured) return null;
    let mapped = structured;
    if ((type === 'select' || type === 'radio') && options?.length) {
      const match = this.optionMatcher.smartMatchOption(structured, options, question);
      if (match) mapped = match;
    }
    console.log(
      `    Rule-based: "${question}" → "${mapped}"${mapped !== structured ? ` (mapped from "${structured}")` : ''}`,
    );
    await this.logQA({ question, type, options, answer: mapped, source: 'rule' });
    return mapped;
  }

  /** Saved rules first, then the model. Unchanged behaviour for existing callers. */
  async answerQuestion(
    question: string,
    type: 'text' | 'textarea' | 'select' | 'radio',
    options?: string[],
  ): Promise<string> {
    const rule = await this.matchSavedRule(question, type, options);
    if (rule !== null) return rule;
    return this.answerWithLlm(question, type, options);
  }

  /** The model half of `answerQuestion`, without re-running the rule lookup. */
  async answerWithLlm(
    question: string,
    type: 'text' | 'textarea' | 'select' | 'radio',
    options?: string[],
  ): Promise<string> {
    const profile = await this.getProfile();

    // for select/radio — pick best option
    if ((type === 'select' || type === 'radio') && options?.length) {
      const demographics = demographicsBlock(profile);
      const saved = await savedAnswersBlock(question);
      const prompt = `
        Question: "${question}"
        Options: ${options.join(', ')}

        Candidate:
        - Title: ${profile.experience.current_level}
        - Years exp: ${profile.experience.total_years}
        - Location: ${profile.personal.location}
        - Visa needed: ${profile.preferences.visa_sponsorship_required}

        Candidate demographics (use these exact values when a question asks about them, including paraphrases like "ethnicity" for race):
        ${demographics}

        Saved answers to past questions (use these when the current question asks for the same information in different words):
        ${saved}

        Reply with ONLY the exact text of the best matching option from the Options list above. Nothing else.
      `;

      const answer = await askLLM(prompt);
      await this.logQA({ question, type, options, answer, source: 'llm' });
      return answer;
    }

    // Select/radio without options — no LLM guesswork; let caller fall back to profile/skip
    if (type === 'select' || type === 'radio') {
      return '';
    }

    // open-ended textarea (also used for text-type when no rule hit)
    const demographics = demographicsBlock(profile);
    const saved = await savedAnswersBlock(question);
    const prompt = `
      Answer this job application question for the candidate.
      Be specific, 2-3 sentences max. Only use real experience from the profile.
      If the question asks for a short numeric or single-word answer (e.g. "years of experience"), reply with just that — no sentence wrapper.

      Candidate:
      - ${profile.experience.total_years} years as ${profile.experience.current_level}
      - Stack: ${profile.skills.languages.join(', ')}, ${profile.skills.frameworks.join(', ')}
      - Achievement: ${profile.top_achievements[0].impact}

      Candidate demographics (use when the question is about self-identification, even under different wording):
      ${demographics}

      Saved answers to past questions (use these when the current question asks for the same information in different words):
      ${saved}

      Question: "${question}"

      Answer directly, no preamble.
    `;

    const answer = await askLLM(prompt);
    await this.logQA({ question, type, options, answer, source: 'llm' });
    return answer;
  }
}

// ── Legacy bridge ──
// The apply/ tree (form-handler.service.ts, easy-apply.service.ts,
// apply/greenhouse/*.service.ts) now injects QuestionAnswererService via real
// Nest DI, so they all share the one Nest-managed singleton — this shim is no
// longer needed for them. The one remaining consumer is eval/answer-eval.ts,
// a standalone CLI script that runs outside any Nest application context (it
// calls answerQuestion directly, once per process, with no other file's state
// to stay in sync with — so the shim's separate instance is harmless there).
// Do NOT let any *Nest-managed* consumer construct its own
// `new QuestionAnswererService(...)` — that would fork it away from the
// shared DI instance (e.g. `setCurrentJob` in one service becoming invisible
// to `answerQuestion` in another).
const legacySingleton = new QuestionAnswererService(new OptionMatcherService());
export const answerQuestion = legacySingleton.answerQuestion.bind(legacySingleton);
export const setCurrentJob = legacySingleton.setCurrentJob.bind(legacySingleton);
export const clearRulesCache = legacySingleton.clearRulesCache.bind(legacySingleton);
