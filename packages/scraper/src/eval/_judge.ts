import { llmChat } from '@job-agent/shared';

export interface JudgeRubric {
  minScore?: number;
  mustMention?: string[];
}

export interface JudgeResult {
  ok: boolean;
  score: number;
  reasons: string[];
  raw: string;
}

interface JudgeInputJob {
  title: string;
  company: string;
  description: string;
}

const JUDGE_SYSTEM =
  'You are a strict editorial reviewer for senior-engineer cover letters. Respond with ONLY valid JSON — no markdown, no preamble.';

function buildJudgePrompt(letter: string, job: JudgeInputJob, rubric: JudgeRubric): string {
  const mustMentionLine = rubric.mustMention?.length
    ? `\nThe letter MUST reference each of these (case-insensitive): ${rubric.mustMention.join(', ')}.`
    : '';
  return `
Score the cover letter below on five dimensions, each 1-5 (1 = fails badly, 5 = excellent):
1. specificity      — Does it reference concrete details about ${job.company} or the role, not generic platitudes?
2. metric_grounding — Are metrics (numbers, percentages) plausibly drawn from real engineering work? An absence of metrics is fine if the role wouldn't naturally call for one — only penalize when the letter MAKES a quantitative claim that feels invented.
3. structure        — A "Dear Hiring Manager," salutation followed by 2–3 short paragraphs and a brief sign-off. The FIRST SENTENCE AFTER the salutation must lead with the company's problem or domain context (NOT "I am writing to" / "I am a"). The salutation itself is required and not a defect.
4. tone             — Direct, senior, confident. NOT eager, gushing, or self-promotional. Humble closings like "I would be grateful for the opportunity to discuss…" are an accepted, reference-style close — do NOT mark these down as apologetic.
5. no_fabrication   — Does it avoid inventing employer names, products, or relationships the candidate clearly wouldn't have?
${mustMentionLine}

Then give a single overall score (1-5) — the MIN of the five dimensions, not the average. A letter with one fatal flaw does not pass. A letter that follows the contract above (correct salutation, problem-first opening sentence, humble close) and references the company specifically should score 4 or 5.

Job:
- Title: ${job.title}
- Company: ${job.company}
- Description: ${job.description.slice(0, 600)}

Cover letter:
"""
${letter}
"""

Respond with ONLY this JSON shape:
{
  "specificity": <1-5>,
  "metric_grounding": <1-5>,
  "structure": <1-5>,
  "tone": <1-5>,
  "no_fabrication": <1-5>,
  "overall": <1-5>,
  "issues": ["<short reason 1>", "<short reason 2>"]
}
`.trim();
}

function safeParse(raw: string): any {
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : cleaned);
  } catch {
    return null;
  }
}

export async function judgeCoverLetter(
  letter: string,
  job: JudgeInputJob,
  rubric: JudgeRubric,
): Promise<JudgeResult> {
  const minScore = rubric.minScore ?? 3;
  const prompt = buildJudgePrompt(letter, job, rubric);
  const raw = await llmChat(prompt, {
    system: JUDGE_SYSTEM,
    temperature: 0,
    maxTokens: 400,
    jsonMode: true,
  });

  const parsed = safeParse(raw);
  if (!parsed || typeof parsed.overall !== 'number') {
    return {
      ok: false,
      score: 0,
      reasons: ['judge returned unparseable JSON'],
      raw,
    };
  }

  const issues: string[] = Array.isArray(parsed.issues)
    ? parsed.issues.filter((i: any) => typeof i === 'string')
    : [];

  return {
    ok: parsed.overall >= minScore,
    score: parsed.overall,
    reasons:
      parsed.overall >= minScore ? [] : [`overall ${parsed.overall} < min ${minScore}`, ...issues],
    raw,
  };
}
