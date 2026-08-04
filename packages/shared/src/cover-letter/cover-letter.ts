import * as crypto from 'crypto';
import { llmChat } from '../llm/clients';
import { UserModel } from '../schemas/user.schema';
import { CoverLetterModel } from '../schemas/cover-letter.schema';
import { loadVoiceSamples } from '../voice/samples';

// Matches ScoredJob's relevant fields without needing to import the scraper type.
interface JobLike {
  title: string;
  company: string;
  location?: string;
  description: string;
  matched_skills?: string[];
  reason?: string;
  externalJobId?: string;
  id?: string;
  externalId?: string;
}

let _profileCache: any = null;
async function getProfile(): Promise<any> {
  if (!_profileCache) _profileCache = await UserModel.findOne().lean();
  return _profileCache;
}

const EDITED_EXEMPLARS_LIMIT = 3;

// Cover letters the candidate manually revised after generation — the strongest voice
// signal available, since it's their own approved edits to this exact kind of writing.
// Excludes the job currently being generated for, so a regenerate doesn't lean on its
// own prior edit. Never throws — a query failure just means no exemplars this call.
async function loadEditedLetterExemplars(excludeExternalJobId?: string): Promise<string[]> {
  try {
    const docs = await CoverLetterModel.find({
      'versions.source': 'edited',
      ...(excludeExternalJobId ? { externalJobId: { $ne: excludeExternalJobId } } : {}),
    })
      .sort({ updatedAt: -1 })
      .limit(EDITED_EXEMPLARS_LIMIT)
      .select('content')
      .lean();
    return docs.map((d: any) => d.content).filter((c: unknown): c is string => typeof c === 'string' && c.length > 0);
  } catch {
    return [];
  }
}

function buildVoiceSection(fileSamples: string[], editedLetters: string[]): string {
  if (fileSamples.length === 0 && editedLetters.length === 0) return '';

  let section = '';

  if (editedLetters.length > 0) {
    const joined = editedLetters.map((s, i) => `### Finalized letter ${i + 1}\n${s}`).join('\n\n');
    section += `
## Cover letters the candidate has personally edited and approved
These are past cover letters the candidate manually revised after generation — the closest
signal available to their real voice for this exact kind of writing. Match their tone,
directness, and how they phrase things. Do NOT copy company-specific details, achievements,
or sentences from them — only the voice and structural choices.

${joined}
`;
  }

  if (fileSamples.length > 0) {
    const joined = fileSamples.map((s, i) => `### Sample ${i + 1}\n${s}`).join('\n\n');
    section += `
## How the candidate actually writes
These are real, unedited writing samples from the candidate — unrelated to this job or to
cover letters. Use them ONLY to calibrate voice: rhythm, word choice, how thoughts connect,
level of formality. Do NOT copy any structure, content, phrases, or sentences from them.

${joined}
`;
  }

  return section;
}

async function selectRelevantAchievements(job: JobLike): Promise<string[]> {
  const profile = await getProfile();
  const descLower = job.description.toLowerCase();

  const isScaleRole = ['transaction', 'payment', 'latency', 'api', 'sla', 'scale'].some((k) =>
    descLower.includes(k),
  );
  const isLeadershipRole = [
    'lead',
    'platform',
    'founding',
    'launch',
    'cross-functional',
    'team',
  ].some((k) => descLower.includes(k));
  const isAIRole = [
    'ai',
    'artificial intelligence',
    'machine learning',
    'ml ',
    'agent',
    'llm',
    'large language model',
    'prompt',
    'genai',
    'gen ai',
    'generative',
    'copilot',
    'anthropic',
    'openai',
    'claude',
    'gpt',
  ].some((k) => descLower.includes(k));

  const achievements = profile.top_achievements;

  const primary = isAIRole
    ? null
    : isScaleRole
      ? achievements.find((a: any) => a.company === 'Nium' && a.impact.includes('100K'))
      : isLeadershipRole
        ? achievements.find((a: any) => a.company === 'Driver Bandhu')
        : achievements.find((a: any) => a.company === 'Ninox Software GmbH');

  const aiAchievement =
    'Built an AI-powered job hunting automation agent using Claude API (Anthropic), prompt engineering, and agentic design patterns — the system autonomously scrapes, scores, generates tailored cover letters, and auto-applies to jobs across multiple platforms.';

  const secondary = achievements.find((a: any) => a !== primary && a.company !== primary?.company);

  if (isAIRole) {
    return [aiAchievement, primary?.impact ?? achievements[0].impact];
  }

  return [primary?.impact ?? achievements[0].impact, secondary?.impact ?? achievements[1].impact];
}

type Variant = { paras: 2 | 3 | 4; opener: 'company_hook' | 'role_hook' | 'direct' };

function hashToIndex(seed: string, length: number): number {
  const hash = crypto.createHash('md5').update(seed).digest('hex');
  return parseInt(hash.slice(0, 8), 16) % length;
}

function pickVariant(seed: string): Variant {
  const parasOptions: Array<2 | 3 | 4> = [2, 3, 4];
  const openerOptions: Array<Variant['opener']> = ['company_hook', 'role_hook', 'direct'];
  return {
    paras: parasOptions[hashToIndex(`${seed}:paras`, parasOptions.length)],
    opener: openerOptions[hashToIndex(`${seed}:opener`, openerOptions.length)],
  };
}

const TOTAL_WORD_BUDGET = 200;

function buildInstructions(variant: Variant, companyName: string): string {
  const perPara = Math.round(TOTAL_WORD_BUDGET / variant.paras);
  const openerGuidance: Record<Variant['opener'], string> = {
    company_hook: `Open with what specifically caught your attention about this role or company — a genuine personal reaction ("What caught my attention was...", "The thing that stood out was..."), not a restatement of the job posting's own description of its work or team.`,
    role_hook: `Lead with the specific technical challenge or nature of the role itself — do not open by naming the company or its business first.`,
    direct: `Open with a plain, direct statement connecting your core expertise to what this job needs — no scene-setting, no rhetorical framing.`,
  };

  const lines = [
    `- Write exactly ${variant.paras} paragraphs, roughly ${perPara} words each — under ${TOTAL_WORD_BUDGET} words total. Every sentence must earn its place.`,
    `- Mention "${companyName}" by name at least once somewhere in the letter (it doesn't have to be in the first sentence — a reaction to the role doesn't require naming the company immediately, but the letter must not go the entire way through without ever naming who it's addressed to).`,
    `- Paragraph 1: ${openerGuidance[variant.opener]} Then use ONE achievement with its exact metric from "Most relevant achievements" above as proof — never invent or alter a number.`,
  ];

  if (variant.paras === 2) {
    lines.push(
      `- Paragraph 2: Connect one specific thing about the company's stack/product/mission to your experience, ending with a single short, humble closing sentence in the same paragraph.`,
    );
  } else if (variant.paras === 3) {
    lines.push(
      `- Paragraph 2: Connect one specific thing about the company's stack/product/mission to your experience.`,
    );
    lines.push(`- Paragraph 3: A single short, humble closing sentence, alone on its own paragraph.`);
  } else {
    lines.push(
      `- Paragraph 2: A second concrete proof point relevant to this role — reference the second achievement above if relevant, don't repeat paragraph 1's metric.`,
    );
    lines.push(
      `- Paragraph 3: Connect one specific thing about the company's stack/product/mission to your experience.`,
    );
    lines.push(`- Paragraph 4: A single short, humble closing sentence, alone on its own paragraph.`);
  }

  lines.push(`- Tone: direct, confident, senior. No filler, no fluff.`);
  lines.push(
    `- Don't repeat the same paragraph shape (topic sentence → proof → clean bridge) in every paragraph — real writing jumps around a little; a paragraph can start mid-thought or connect to the next one without a smooth transition sentence.`,
  );
  return lines.join('\n');
}

async function buildCoverLetterPrompt(job: JobLike): Promise<string> {
  const profile = await getProfile();
  const achievements = await selectRelevantAchievements(job);
  const selfId = job.externalJobId ?? job.id ?? job.externalId;
  const editedExemplars = await loadEditedLetterExemplars(selfId);
  const voiceSection = buildVoiceSection(loadVoiceSamples(), editedExemplars);

  const descLower = job.description.toLowerCase();
  const needsAI = [
    'ai',
    'agent',
    'llm',
    'machine learning',
    'ml ',
    'prompt',
    'genai',
    'generative',
    'anthropic',
    'openai',
    'copilot',
  ].some((k) => descLower.includes(k));

  const aiSkillsLine = needsAI
    ? `\n- AI expertise: Claude API (Anthropic), AI Agent Design, Prompt Engineering, Agentic Workflows, LLM integration`
    : '';

  const seed = selfId ?? `${job.company}::${job.title}`;
  const variant = pickVariant(seed);

  return `
You are writing a cover letter for a senior software engineer job application.
${voiceSection}

## Candidate
- Name: ${profile.personal.name}
- Title: ${profile.experience.current_level}
- Years of experience: ${profile.experience.total_years}
- Core stack: ${profile.skills.languages.join(', ')}, ${profile.skills.frameworks.join(', ')}
- Architecture expertise: ${profile.skills.architecture.join(', ')}${aiSkillsLine}

## Most relevant achievements for THIS role
1. ${achievements[0]}
2. ${achievements[1]}

## Job
- Title: ${job.title}
- Company: ${job.company}
- Location: ${job.location ?? ''}
- Matched skills: ${(job.matched_skills ?? []).join(', ')}
- Description: ${job.description.slice(0, 1000)}

## Scoring rubric for this role
${job.reason ?? ''}

## Writing style rules
- Always use "I" instead of the candidate's name (${profile.personal.name})
- Write in first person throughout
- Never refer to the candidate in third person

## Avoid these AI-generated tells
- Don't open by restating or paraphrasing the job posting's own language back at the company —
  react to something specific from your own vantage point, not a summary of what their team
  already says it's doing.
- Don't summarize what a project "gave you experience in," "taught you," or "demonstrates your
  ability to do." Describe the actual specific decision, tradeoff, or moment behind the work.
  BAD (tells): "That work gave me direct experience designing multi-step agentic workflows."
  GOOD (shows): "A lot of the work has been figuring out how to make the system reliable —
  deciding what should be deterministic, when to call an LLM, and how to recover when a step
  fails."

## Instructions — follow exactly
${buildInstructions(variant, job.company)}

## Banned phrases — do NOT use any of these
"I am thrilled", "I am excited", "I am passionate", "I am confident",
"I would be a great fit", "resonates with me", "thank you for considering",
"make an immediate impact", "I'd love to", "Let's schedule",
"would be beneficial", "I look forward to", "Please consider",
"I am writing to", "strong passion", "dream company",
"I am impressed by", "I am drawn to", "resonates with",
"eager to leverage", "I am eager", "ideal candidate",
"honed my skills", "positions me as", "leveraged", "utilized",
"cutting-edge", "robust", "seamless", "fast-paced",
"genuinely hard", "novelty layer", "bolted onto", "reliability isn't optional",
"multi-step agentic workflows"

Write the cover letter body with "Dear Hiring Manager," at the top and a brief professional sign-off with the candidate's name at the end. No subject line, no date.
`.trim();
}

const HUMANIZE_SYSTEM = (level: string, years: number, companyName: string) => `
You are editing writing for a ${level} with ${years} years of experience.

Rewrite this so it sounds like an experienced software engineer describing their own work.

Rules:
- Preserve all facts, numbers and technologies.
- Never invent achievements.
- The letter must still mention "${companyName}" by name somewhere — if your edit happens to
  remove the only mention of it, add it back in naturally rather than leaving the letter
  without ever naming who it's addressed to.
- Remove marketing language.
- Avoid phrases like "passionate", "leveraged", "utilized", "cutting-edge", "robust", "seamless",
  "fast-paced", "I'm excited to", "genuinely hard", "novelty layer", "bolted onto",
  "reliability isn't optional", "multi-step agentic workflows".
- Keep some contractions, but don't force them.
- Mix short and long sentences.
- Prefer concrete examples over abstract claims.
- If the opening restates or paraphrases the job posting's own language back at the company,
  rewrite it as a genuine personal reaction instead — what specifically caught your attention,
  not a summary of what their team already says it's doing.
- Don't repeat the same paragraph shape (topic → proof → clean bridge) throughout. Vary how
  paragraphs connect — an occasional direct jump or aside reads more human than a perfectly
  threaded argument.
- Replace capability-labels ("gave me experience in X", "demonstrates my ability to Y", "that
  work taught me Z") with the specific decision, tradeoff, or moment behind the work.
  BAD (tells): "That work gave me direct experience designing multi-step agentic workflows."
  GOOD (shows): "A lot of the work has been figuring out how to make the system reliable —
  deciding what should be deterministic, when to call an LLM, and how to recover when a step
  fails."
- Make every sentence sound like something someone would naturally say or write.
- If a sentence already sounds natural, leave it unchanged.
- Output ONLY the rewritten letter text — no preamble, no explanation, no notes or summary
  of what you changed, before or after it.
`.trim();

async function humanizeCoverLetter(draft: string, companyName: string): Promise<string> {
  const profile = await getProfile();
  const text = await llmChat(draft, {
    system: HUMANIZE_SYSTEM(profile.experience.current_level, profile.experience.total_years, companyName),
    temperature: 0.3,
    maxTokens: 400,
  });
  return text
    .replace(
      /^(?:here(?:'s| is) (?:the |a |your )?(?:edited|revised|rewritten)?\s*(?:cover letter|version)?[:\s]*\n*)/i,
      '',
    )
    // Defensively cut any trailing commentary the model appends after the letter itself
    // (e.g. a "---\nMain changes: ..." explanation block), regardless of the instruction above.
    .replace(/\n+---+\s*\n[\s\S]*$/, '')
    .trim();
}

export interface CoverLetterResult {
  raw: string;
  final: string;
}

export async function generateCoverLetter(job: JobLike): Promise<CoverLetterResult> {
  const prompt = await buildCoverLetterPrompt(job);
  let raw = await llmChat(prompt, { temperature: 0.2, maxTokens: 400 });
  // Strip LLM preamble lines like "Here is the cover letter:"
  raw = raw.replace(/^(?:here(?:'s| is) (?:the |a |your )?cover letter[:\s]*\n*)/i, '').trim();

  let final = raw;
  try {
    final = await humanizeCoverLetter(raw, job.company);
  } catch (err) {
    console.error(`  Humanize pass failed, falling back to raw draft: ${(err as Error).message}`);
  }

  return { raw, final };
}
