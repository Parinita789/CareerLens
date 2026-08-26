import { describe, it, expect } from 'vitest';
import { FieldAnswerResolverService } from '../answer-resolution/field-answer-resolver.service';
import type { FieldAnswerRequest } from '../answer-resolution/field-answer-resolver.service';
import { OptionMatcherService } from '../answer-resolution/option-matcher.service';
import type { DirectAnswerService } from '../answer-resolution/direct-answer.service';
import type { QuestionAnswererService } from '../answer-resolution/question-answerer.service';

// Counts what each source was asked for, so a test can assert the chain stopped
// early rather than merely that the right value came out.
function build(opts: { rule?: string | null; profile?: string | null; llm?: string }) {
  const calls = { rule: 0, profile: 0, llm: 0 };
  const answerer = {
    async matchSavedRule() {
      calls.rule++;
      return opts.rule ?? null;
    },
    async answerWithLlm() {
      calls.llm++;
      return opts.llm ?? '';
    },
  } as unknown as QuestionAnswererService;
  const direct = {
    getDirectAnswer() {
      calls.profile++;
      return opts.profile ?? null;
    },
  } as unknown as DirectAnswerService;
  // The real matcher — option mapping is the part most likely to break.
  return { resolver: new FieldAnswerResolverService(new OptionMatcherService(), direct, answerer), calls };
}

const req = (over: Partial<FieldAnswerRequest> = {}): FieldAnswerRequest => ({
  label: 'Gender',
  type: 'radio',
  options: ['Male', 'Female', 'Decline to self-identify'],
  profile: {},
  getPreScrapedAnswer: () => null,
  ...over,
});

describe('FieldAnswerResolverService', () => {
  it('prefers the reviewed pre-scraped answer over every other source', async () => {
    const { resolver, calls } = build({ rule: 'Male', profile: 'Male' });
    const got = await resolver.resolve(req({ getPreScrapedAnswer: () => 'Female' }));
    expect(got).toEqual({ value: 'Female', source: 'pre-scraped' });
    // Nothing downstream should even be consulted.
    expect(calls).toEqual({ rule: 0, profile: 0, llm: 0 });
  });

  it('prefers a saved rule over the profile default', async () => {
    const { resolver, calls } = build({ rule: 'Female', profile: 'Male' });
    const got = await resolver.resolve(req());
    expect(got).toEqual({ value: 'Female', source: 'rule' });
    expect(calls.profile).toBe(0);
  });

  it('falls back to the profile when no rule matches', async () => {
    const { resolver } = build({ rule: null, profile: 'Female' });
    await expect(resolver.resolve(req())).resolves.toEqual({ value: 'Female', source: 'profile' });
  });

  it('skips a stored model refusal and moves to the next source', async () => {
    const { resolver } = build({ rule: 'Female' });
    const got = await resolver.resolve(
      req({ getPreScrapedAnswer: () => "I can't answer that on the candidate's behalf" }),
    );
    expect(got).toEqual({ value: 'Female', source: 'rule' });
  });

  it('falls through when a candidate matches none of the options', async () => {
    // The live failure this models: a phone number offered for a Yes/No consent group.
    const { resolver } = build({ rule: null, profile: 'Female' });
    const got = await resolver.resolve(req({ getPreScrapedAnswer: () => '+1 669-367-1049' }));
    expect(got).toEqual({ value: 'Female', source: 'profile' });
  });

  it('resolves an answer to the actual option text', async () => {
    const { resolver } = build({ rule: 'Asian' });
    const got = await resolver.resolve(
      req({
        label: 'Race',
        options: ['Hispanic or Latino', 'Asian (Not Hispanic or Latino)', 'Decline to self-identify'],
      }),
    );
    expect(got).toEqual({ value: 'Asian (Not Hispanic or Latino)', source: 'rule' });
  });

  it('leaves free-text answers unmapped', async () => {
    const { resolver } = build({ profile: '5' });
    const got = await resolver.resolve(
      req({ label: 'Years of experience', type: 'text', options: undefined }),
    );
    expect(got).toEqual({ value: '5', source: 'profile' });
  });

  it('never calls the model unless the caller opts in', async () => {
    const { resolver, calls } = build({ rule: null, profile: null, llm: 'Female' });
    await expect(resolver.resolve(req())).resolves.toBeNull();
    expect(calls.llm).toBe(0);
  });

  it('calls the model last, and only with allowLlm', async () => {
    const { resolver, calls } = build({ rule: null, profile: null, llm: 'Female' });
    const got = await resolver.resolve(req({ allowLlm: true }));
    expect(got).toEqual({ value: 'Female', source: 'llm' });
    expect(calls).toEqual({ rule: 1, profile: 1, llm: 1 });
  });

  it('returns null when no source has a usable answer', async () => {
    const { resolver } = build({ rule: null, profile: null });
    await expect(resolver.resolve(req())).resolves.toBeNull();
  });

  it('survives a failing rule lookup and continues down the chain', async () => {
    const answerer = {
      async matchSavedRule() {
        throw new Error('mongo is down');
      },
      async answerWithLlm() {
        return '';
      },
    } as unknown as QuestionAnswererService;
    const direct = { getDirectAnswer: () => 'Female' } as unknown as DirectAnswerService;
    const resolver = new FieldAnswerResolverService(new OptionMatcherService(), direct, answerer);
    await expect(resolver.resolve(req())).resolves.toEqual({ value: 'Female', source: 'profile' });
  });

  it('passes an empty field id through when the ATS has none', async () => {
    let seen: string | undefined;
    const { resolver } = build({});
    await resolver.resolve(
      req({
        getPreScrapedAnswer: (id) => {
          seen = id;
          return null;
        },
      }),
    );
    expect(seen).toBe('');
  });
});
