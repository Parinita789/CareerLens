import { llmChatWithRetry } from '@job-agent/shared';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import type { JobListing } from '../types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

const profile = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../profile/candidate.json'), 'utf-8'),
);

function safeParseJSON(raw: string) {
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);

    return JSON.parse(cleaned);
  } catch {
    return {
      fit_score: 0,
      apply: false,
      matched_skills: [],
      missing_skills: [],
      reason: 'Parse error',
    };
  }
}

function buildScorerPrompt(job: JobListing): string {
  const workSummary = profile.work_history
    .map((j: any) => `- ${j.title} at ${j.company} (${j.duration_years} yrs)`)
    .join('\n');

  return `
You are evaluating job fit for a specific candidate. Be strict and accurate.

## Candidate
- Current level: ${profile.experience.current_level}
- Years experience: ${profile.experience.total_years}
- Languages: ${profile.skills.languages.join(', ')}
- Frameworks: ${profile.skills.frameworks.join(', ')}
- Databases: ${(profile.skills.databases || []).join(', ')}
- Messaging: ${(profile.skills.messaging || []).join(', ')}
- Cloud: ${(profile.skills.cloud || []).join(', ')}
- DevOps: ${(profile.skills.devops || []).join(', ')}
- Architecture: ${(profile.skills.architecture || []).join(', ')}
- AI: ${(profile.skills.ai || []).join(', ')}
- Tools: ${(profile.skills.tools || []).join(', ')}
- Work history:
${workSummary}

## Scoring Rubric — use this exactly
9-10: Perfect match. Core stack identical (Node.js/TypeScript), distributed systems, backend-focused. Seniority from Senior to lead is fine.
7-8:  Good match. Most requirements align, 1-2 minor gaps, backend-heavy role. senior, lead-level roles where tech stack matches should score 7+.
5-6:  Partial match. Some overlap but significant gaps or role is not pure backend.
3-4:  Weak match. Different primary stack (.NET, Java, Python-only) or wrong domain entirely.
1-2:  Poor match. Completely different stack, role type, or seniority level.

## Important: Seniority is NOT a disqualifier
- Candidate has 7 years of experience — this qualifies for Senior AND Lead roles.
- Do NOT penalize score for Staff/Principal titles if the tech stack matches.
- Score based on TECH STACK FIT, not job title seniority.

## Hard rules — automatically score 3 or below if ANY of these apply
- Primary language is NOT TypeScript/JavaScript/Node.js (e.g. Java-only, .NET/C#-only, Python-only)
- Role is primarily frontend (React, CSS, UI/UX focus)
- Role requires technologies candidate has ZERO experience with as PRIMARY skill (e.g. ServiceNow, Dynamics CRM, BIOS firmware)
- Role is DevOps/SRE/Security focused, not backend engineering

## Few-shot examples — learn from these

### Example 1 — Strong match (score: 9)
Candidate: Node.js/TypeScript, microservices, AWS, 7 years
Job: "Senior Backend Engineer, Node.js/TypeScript, distributed systems, payment APIs, AWS"
Output: {
  "fit_score": 9,
  "apply": true,
  "matched_skills": ["Node.js", "TypeScript", "AWS", "microservices", "distributed systems", "Javascript"],
  "missing_skills": [],
  "reason": "Near-perfect match on stack, architecture patterns, and seniority level."
}

### Example 2 — Weak match (score: 3)
Candidate: Node.js/TypeScript, microservices, AWS, 7 years
Job: "Senior .NET Developer, C#, ASP.NET, Microsoft Azure, SharePoint, SQL Server"
Output: {
  "fit_score": 3,
  "apply": false,
  "matched_skills": ["Azure"],
  "missing_skills": [".NET", "C#", "ASP.NET", "SharePoint"],
  "reason": "Primary stack is .NET/C# which candidate has no experience with."
}

### Example 3 — Partial match (score: 5)
Candidate: Node.js/TypeScript, microservices, AWS, 7 years
Job: "Full Stack Engineer, React/Node.js, TypeScript, frontend-heavy, pixel-perfect UI"
Output: {
  "fit_score": 5,
  "apply": false,
  "matched_skills": ["Node.js", "TypeScript"],
  "missing_skills": ["React", "frontend", "CSS"],
  "reason": "Stack partially matches but role is frontend-heavy, not backend-focused."
}

### Example 4 — Wrong domain (score: 2)
Candidate: Node.js/TypeScript, microservices, AWS, 7 years
Job: "ServiceNow Developer, ITSM workflows, ServiceNow scripting, Glide API"
Output: {
  "fit_score": 2,
  "apply": false,
  "matched_skills": [],
  "missing_skills": ["ServiceNow", "ITSM", "Glide API"],
  "reason": "Completely different domain and tooling — no relevant overlap."
}

## Job to evaluate now
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Description: ${job.description.slice(0, 500)}

IMPORTANT rules for matched_skills and missing_skills:
- matched_skills: skills the job requires that the candidate HAS (listed above)
- missing_skills: skills the job requires that the candidate does NOT have
- NEVER list a skill as missing if it appears anywhere in the candidate's profile above
- For example: NestJS, CloudFront, Docker, Redis, MongoDB, AWS etc. are in the candidate's profile — do NOT list them as missing

Respond with ONLY a JSON object. Start with { and end with }. No other text.
{
  "fit_score": <number 1-10>,
  "apply": <true or false>,
  "matched_skills": [<list>],
  "missing_skills": [<list>],
  "reason": "<one sentence, be specific about why>"
}
`;
}

interface ScoreResult {
  fit_score: number;
  apply: boolean;
  matched_skills: string[];
  missing_skills: string[];
  reason: string;
}

async function callWithRetry(prompt: string): Promise<string> {
  return llmChatWithRetry(prompt, {
    system:
      'You are a JSON-only assistant. Always respond with valid JSON. No explanations, no markdown.',
    temperature: 0.1,
    maxTokens: 300,
    jsonMode: true,
  });
}

export async function scoreFitWithLLM(job: JobListing): Promise<ScoreResult> {
  const prompt = buildScorerPrompt(job);
  const raw = await callWithRetry(prompt);
  return safeParseJSON(raw);
}
