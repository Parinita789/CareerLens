import { llmChat } from '../llm/clients';
import { UserModel } from '../schemas/user.schema';

// Matches ScoredJob's relevant fields without needing to import the scraper type.
interface JobLike {
  title: string;
  company: string;
  location?: string;
  description: string;
  matched_skills?: string[];
  reason?: string;
}

let _profileCache: any = null;
async function getProfile(): Promise<any> {
  if (!_profileCache) _profileCache = await UserModel.findOne().lean();
  return _profileCache;
}

// Single gold-standard cover letter — used as a one-shot example.
const REFERENCE_LETTERS = [
  {
    title: 'Senior Software Engineer, Backend (Streaming Infrastructure)',
    company: 'Affirm',
    content: `Scaling event-driven infrastructure without fragmenting reliability is one of the hardest problems in distributed systems — it's also one I've solved directly. When a monolithic payment platform was collapsing under its own complexity, I decomposed it into a microservices architecture capable of sustaining 100K+ daily transactions while reducing release cycles from three weeks to four days.
      The numbers speak to what's possible when architecture decisions are deliberate. That 75% reduction in release cycle time came from isolating failure domains and building services that could deploy and scale independently. Separately, 60% efficiency gains across an entire sales organization came from designing a Node.js/NestJS microservice that eliminated all manual intervention from a workflow that previously required three full-time employees — the system handled orchestration, state management, and edge cases without human input.
      Affirm's streaming team sits at a genuinely hard intersection: real-time pipelines, massive data volumes, and cross-team infrastructure that other workloads depend on getting right. My event-driven architecture work in TypeScript and Node.js maps directly to the coordination and reliability challenges your Kafka and Flink pipelines face at scale — particularly around designing systems that degrade gracefully when upstream sources fluctuate.
      I would be grateful for the opportunity to discuss how my distributed systems experience could contribute to Affirm's streaming infrastructure challenges.`,
  },
];

function getExamples(): string {
  let section = `
    ## Reference cover letter — MATCH THIS EXACT STYLE
    Study the example carefully. Your output must match:
    - Same paragraph structure (3 paragraphs)
    - Opening: company's specific problem, not "I am" or "Dear"
    - Paragraph 2: lead with the metric, not "I did X"
    - Paragraph 3: connect ONE specific thing about the company to candidate's experience
    - Tone: direct, senior, confident — never eager or grateful
    - No banned phrases
  `;
  REFERENCE_LETTERS.forEach((ex, i) => {
    section += `\n### Example ${i + 1}: ${ex.title} @ ${ex.company}\n${ex.content}\n`;
  });
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

async function buildCoverLetterPrompt(job: JobLike): Promise<string> {
  const profile = await getProfile();
  const achievements = await selectRelevantAchievements(job);
  const examples = getExamples();

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

  return `
You are writing a cover letter for a senior software engineer job application.
${examples}

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

## Instructions — follow exactly
- Write exactly 2 short paragraphs, maximum 4 sentences each
- Paragraph 1: One sentence on what the company needs, then 2 sentences proving the candidate has done it — use ONE achievement with the exact metric.
- Paragraph 2: Connect one specific thing about the company's stack/product to the candidate's experience.
- Paragraph 3 (separate, short): A single humble closing sentence on its own paragraph. Example: "I would be grateful for the opportunity to discuss how I could contribute to [specific thing at the company]."
- Under 150 words total. Every sentence must earn its place.
- Tone: direct, confident, senior. No filler, no fluff.

## Banned phrases — do NOT use any of these
"I am thrilled", "I am excited", "I am passionate", "I am confident",
"I would be a great fit", "resonates with me", "thank you for considering",
"make an immediate impact", "I'd love to", "Let's schedule",
"would be beneficial", "I look forward to", "Please consider",
"I am writing to", "strong passion", "dream company",
"I am impressed by", "I am drawn to", "resonates with",
"eager to leverage", "I am eager", "ideal candidate",
"honed my skills", "positions me as"

Write the cover letter body with "Dear Hiring Manager," at the top and a brief professional sign-off with the candidate's name at the end. No subject line, no date.
`.trim();
}

export async function generateCoverLetter(job: JobLike): Promise<string> {
  const prompt = await buildCoverLetterPrompt(job);
  let text = await llmChat(prompt, { temperature: 0.2, maxTokens: 350 });
  // Strip LLM preamble lines like "Here is the cover letter:"
  text = text.replace(/^(?:here(?:'s| is) (?:the |a |your )?cover letter[:\s]*\n*)/i, '').trim();
  return text;
}
