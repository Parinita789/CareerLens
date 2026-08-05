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
  dimensions?: Record<string, number>;
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
Score the cover letter below on six dimensions, each 1-5 (1 = fails badly, 5 = excellent):
1. specificity      — Does it reference concrete details about ${job.company} or the role, not generic platitudes?
2. metric_grounding — Are metrics (numbers, percentages) plausibly drawn from real engineering work? An absence of metrics is fine if the role wouldn't naturally call for one — only penalize when the letter MAKES a quantitative claim that feels invented.
3. structure        — A "Dear Hiring Manager," salutation followed by 2–4 short paragraphs and a brief sign-off. The FIRST SENTENCE AFTER the salutation should open with a clear hook — the company's specific problem/domain, the specific challenge of the role itself, or a direct statement connecting the candidate's expertise to the job — as long as it is NOT a generic "I am writing to" / "I am a" opener. The salutation itself is required and not a defect.
4. tone             — Direct, senior, confident. NOT eager, gushing, or self-promotional. Humble closings like "I would be grateful for the opportunity to discuss…" are an accepted, reference-style close — do NOT mark these down as apologetic.
5. no_fabrication   — Does it avoid inventing employer names, products, or relationships the candidate clearly wouldn't have?
6. voice_match      — Does it avoid reading like AI-generated output, specifically:
   - The opening reacts to the role/company from the candidate's own vantage point — it does
     NOT restate or paraphrase the job posting's own language back at it, even if the job
     description itself is full of buzzwords or marketing language.
   - No generic AI-cliché phrases or vague capability-labels used as a stand-in for a real
     detail (e.g. "genuinely hard", "novelty layer", "bolted onto", "reliability isn't
     optional", "multi-step agentic workflows" used generically rather than describing an
     actual specific).
   - Concrete decisions, tradeoffs, or moments instead of abstract "gave me experience in X" /
     "demonstrates my ability to Y" labels.
   - Paragraphs don't all follow an identical topic-sentence → proof → clean-bridge shape —
     some variation in how ideas connect.
   Score 1-2 if the opener is a clear paraphrase of the job posting, or if capability-labels
   replace concrete specifics. Score 5 only if all of the above hold.
${mustMentionLine}

Then give a single overall score (1-5) — the MIN of the six dimensions, not the average. A letter with one fatal flaw does not pass. A letter that follows the contract above (correct salutation, a clear non-generic opening hook, humble close, genuine voice) and references the company specifically should score 4 or 5.

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
  "voice_match": <1-5>,
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

  const dimensions: Record<string, number> = {};
  for (const key of ['specificity', 'metric_grounding', 'structure', 'tone', 'no_fabrication', 'voice_match']) {
    if (typeof parsed[key] === 'number') dimensions[key] = parsed[key];
  }

  return {
    ok: parsed.overall >= minScore,
    score: parsed.overall,
    reasons:
      parsed.overall >= minScore ? [] : [`overall ${parsed.overall} < min ${minScore}`, ...issues],
    raw,
    dimensions,
  };
}
