import * as crypto from 'crypto';
import type { JobListing } from '../types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRelevantRole(title: string, description: string, location: string): boolean {
  const t = title.toLowerCase();
  const d = description.toLowerCase();
  const loc = location.toLowerCase();

  // ── Hard excludes on title — instant reject ───────────────────────
  const titleExcludes = [
    'frontend',
    'front-end',
    'ios ',
    'android',
    'data scientist',
    'machine learning engineer',
    'designer',
    'ux ',
    'product manager',
    ' pm ',
    'sales ',
    'recruiter',
    'marketing',
    'finance',
    'legal',
    'test engineer',
    'sdet',
    'qa engineer',
    'devrel',
    'developer advocate',
    'embedded',
    'firmware',
    'hardware',
    'data analyst',
    'analytics engineer',
    'junior',
    'intern ',
    'graduate new',
    'php developer',
    'ruby developer',
    '.net developer',
    'java developer',
    'android developer',
  ];
  if (titleExcludes.some((k) => t.includes(k))) return false;

  // ── Must be a software/backend/platform role ──────────────────────
  const roleTitles = [
    'software engineer',
    'software developer',
    'backend engineer',
    'back-end engineer',
    'platform engineer',
    'fullstack',
    'full stack',
    'senior engineer',
    'senior developer',
    'engineer ii',
    'engineer iii',
    'engineer iv',
    'api engineer',
    'infrastructure engineer',
    'engineer,',
    'engineer -',
  ];
  const hasRoleTitle = roleTitles.some((k) => t.includes(k));
  if (!hasRoleTitle) return false;

  // ── Tech check — title OR description (much more permissive) ──────
  const techSignals = [
    'node',
    'typescript',
    'javascript',
    'golang',
    ' go ',
    'nestjs',
    'express',
    'fastify',
    'next.js',
    'microservice',
    'distributed',
    'event-driven',
    'api',
    'rest',
    'graphql',
    'aws',
    'gcp',
    'azure',
    'cloud',
    'docker',
    'kubernetes',
    'k8s',
    'mongodb',
    'postgresql',
    'postgres',
    'redis',
    'kafka',
    'rabbitmq',
    'pubsub',
    'backend',
    'back-end',
    'server-side',
    'scalab',
    'high-traffic',
    'high traffic',
    'latency',
    'throughput',
    'distributed system',
  ];

  // check title first (strong signal)
  const titleHasTech = techSignals.some((k) => t.includes(k));

  // check description (weaker signal — only need 2+ matches)
  const descMatches = techSignals.filter((k) => d.includes(k)).length;
  const descHasTech = descMatches >= 2;

  if (!titleHasTech && !descHasTech) return false;

  // ── Location filter ───────────────────────────────────────────────
  const remoteHybridSignals = [
    'remote',
    'hybrid',
    'distributed',
    'united states',
    'us only',
    'us-based',
    'anywhere',
    'san francisco',
    'new york',
    'seattle',
    'austin',
    'los angeles',
    'denver',
    'chicago',
    'boston',
    'california',
    'bay area',
  ];

  const isRemoteHybrid =
    location === '' ||
    location.toLowerCase() === 'anywhere' ||
    remoteHybridSignals.some((k) => loc.includes(k));

  return isRemoteHybrid;
}

export async function scrapeLever(companySlug: string, companyName: string): Promise<JobListing[]> {
  const url = `https://api.lever.co/v0/postings/${companySlug}?mode=json`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        console.log(`    ${companyName}: board not found`);
        return [];
      }
      console.log(`    ${companyName}: API returned ${response.status}`);
      return [];
    }

    const postings = (await response.json()) as any[];

    if (!postings?.length) {
      console.log(`    ${companyName}: no open positions`);
      return [];
    }

    const jobs: JobListing[] = [];

    for (const posting of postings) {
      const title = posting.text ?? '';
      const location = posting.categories?.location ?? posting.workplaceType ?? '';
      const team = posting.categories?.team ?? '';

      // build description from lever's structured format
      const description = [
        posting.descriptionPlain ?? posting.description ?? '',
        posting.lists?.map((l: any) => `${l.text}: ${l.content}`).join('\n') ?? '',
        posting.additionalPlain ?? '',
      ]
        .join('\n')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!isRelevantRole(title, description, `${location} ${team}`)) continue;

      jobs.push({
        id: crypto
          .createHash('md5')
          .update(`lever-${companySlug}-${posting.id}`)
          .digest('hex')
          .slice(0, 10),
        title,
        company: companyName,
        location,
        remote: location.toLowerCase().includes('remote') || posting.workplaceType === 'remote',
        employment_type: 'full-time',
        description,
        url: posting.hostedUrl ?? posting.applyUrl ?? '',
        source: 'lever' as const,
        scraped_at: new Date().toISOString(),
        posted_at: posting.createdAt ? new Date(posting.createdAt).toISOString() : undefined,
      });
    }

    console.log(`    ${companyName}: ${postings.length} total → ${jobs.length} relevant`);

    return jobs;
  } catch (err) {
    console.log(`    ${companyName}: fetch failed — ${(err as Error).message}`);
    return [];
  } finally {
    await sleep(300);
  }
}
