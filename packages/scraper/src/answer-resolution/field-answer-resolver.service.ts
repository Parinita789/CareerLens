import { Inject, Injectable } from '@nestjs/common';
import { OptionMatcherService } from './option-matcher.service';
import { DirectAnswerService } from './direct-answer.service';
import { QuestionAnswererService } from './question-answerer.service';
import { isRefusalText } from './refusal';

export type FieldType = 'text' | 'textarea' | 'select' | 'radio';
export type AnswerSource = 'pre-scraped' | 'rule' | 'profile' | 'llm';

export interface FieldAnswerRequest {
  /** The question as shown to the applicant. */
  label: string;
  type: FieldType;
  /** ATS field id, where one exists — some pre-scraped answers are keyed by it. */
  fieldId?: string;
  /** Choices for select/radio. When present the answer must match one of them. */
  options?: string[];
  profile: any;
  getPreScrapedAnswer: (fieldId: string, label: string) => string | null;
  /**
   * Permit the model fallback. Off by default: it costs a call per unanswered
   * field, so only call sites that already paid for one should opt in.
   */
  allowLlm?: boolean;
  /**
   * Per-form memo, created by the caller and shared across that form's fields.
   * ATS markup routinely nests the same question in several containers, so
   * without this a single form re-reads the rules from Mongo and writes a
   * duplicate Q&A audit row for every repeat. Never hold one across forms — the
   * resolver is a singleton and answers are job-specific.
   */
  cache?: Map<string, ResolvedFieldAnswer | null>;
  /**
   * Longest acceptable *generated* answer. Single-line inputs use this to reject
   * prose — a model asked an open question will happily return a paragraph, which
   * is worse in a one-line field than leaving it blank. It deliberately does not
   * apply to pre-scraped answers: the user reviewed those, so they are trusted at
   * any length.
   */
  maxLength?: number;
}

export interface ResolvedFieldAnswer {
  value: string;
  source: AnswerSource;
}

/**
 * The single answer-resolution chain for application form fields.
 *
 * Order is cheapest-and-most-authoritative first: an answer the user reviewed in
 * the Prepare tab, then a rule they saved by correcting a past answer, then their
 * profile, and only then a model guess. Each source is skipped when it yields
 * nothing usable — for select/radio that includes yielding a value that matches no
 * available option, which is why the chain falls through rather than aborting.
 *
 * This exists because both form fillers had hand-rolled the chain at every field
 * type — twelve copies — and they had drifted: only Ashby radios consulted saved
 * rules at all, and Ashby's native selects checked the profile *before* the
 * pre-scraped answer, so a reviewed answer lost to a hardcoded default.
 */
@Injectable()
export class FieldAnswerResolverService {
  constructor(
    @Inject(OptionMatcherService) private readonly optionMatcher: OptionMatcherService,
    @Inject(DirectAnswerService) private readonly directAnswer: DirectAnswerService,
    @Inject(QuestionAnswererService) private readonly questionAnswerer: QuestionAnswererService,
  ) {}

  /** Builds the per-form memo to pass as `cache` on each request. */
  newCache(): Map<string, ResolvedFieldAnswer | null> {
    return new Map();
  }

  async resolve(req: FieldAnswerRequest): Promise<ResolvedFieldAnswer | null> {
    const fieldId = req.fieldId ?? '';
    // allowLlm and maxLength are part of the key: the same field asked with the
    // model disabled legitimately resolves to null, and that null must not be
    // served back to a later call that does permit it.
    const key = [
      req.type,
      req.allowLlm ? 'llm' : 'nollm',
      req.maxLength ?? '',
      req.label,
      (req.options ?? []).join('|'),
    ].join('\u0000');
    if (req.cache?.has(key)) return req.cache.get(key) ?? null;
    const answer = await this.resolveUncached(req, fieldId);
    req.cache?.set(key, answer);
    return answer;
  }

  private async resolveUncached(
    req: FieldAnswerRequest,
    fieldId: string,
  ): Promise<ResolvedFieldAnswer | null> {

    const preScraped = this.usable(req.getPreScrapedAnswer(fieldId, req.label), req, 'pre-scraped');
    if (preScraped) return { value: preScraped, source: 'pre-scraped' };

    const rule = this.usable(
      await this.questionAnswerer.matchSavedRule(req.label, req.type, req.options).catch(() => null),
      req,
      'rule',
    );
    if (rule) return { value: rule, source: 'rule' };

    const profile = this.usable(
      this.directAnswer.getDirectAnswer(fieldId, req.label, req.profile, req.type),
      req,
      'profile',
    );
    if (profile) return { value: profile, source: 'profile' };

    if (req.allowLlm) {
      const llm = this.usable(
        await this.questionAnswerer.answerWithLlm(req.label, req.type, req.options).catch(() => ''),
        req,
        'llm',
      );
      if (llm) return { value: llm, source: 'llm' };
    }

    return null;
  }

  /**
   * Screens one candidate. Rejects empties and stored model refusals, and for
   * option-bearing fields resolves the candidate to an actual option — returning
   * null when it matches none, so the caller moves on to the next source.
   */
  private usable(
    value: string | null | undefined,
    req: FieldAnswerRequest,
    source: AnswerSource,
  ): string | null {
    if (!value || isRefusalText(value)) return null;
    if (source !== 'pre-scraped' && req.maxLength && value.length > req.maxLength) return null;
    if (req.options?.length) {
      return this.optionMatcher.smartMatchOption(value, req.options, req.label);
    }
    return value;
  }
}
