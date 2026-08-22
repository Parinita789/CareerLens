import { Injectable } from '@nestjs/common';
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

@Injectable()
export class GreenhouseService {
  async scrapeGreenhouse(companySlug: string, companyName: string): Promise<JobListing[]> {
    const url = `https://boards-api.greenhouse.io/v1/boards/${companySlug}/jobs?content=true`;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          console.log(`    ${companyName}: board not found (slug may be wrong)`);
          return [];
        }
        console.log(`    ${companyName}: API returned ${response.status}`);
        return [];
      }

      const data = (await response.json()) as { jobs: any[] };

      if (!data.jobs?.length) {
        console.log(`    ${companyName}: no open positions`);
        return [];
      }

      const jobs: JobListing[] = [];

      for (const job of data.jobs) {
        const title = job.title ?? '';
        const location = job.location?.name ?? '';
        const description = job.content ?? '';
        const url = job.absolute_url ?? '';

        if (!isRelevantRole(title, description, location)) continue;

        jobs.push({
          id: crypto
            .createHash('md5')
            .update(`greenhouse-${companySlug}-${job.id}`)
            .digest('hex')
            .slice(0, 10),
          title,
          company: companyName,
          location,
          remote: location.toLowerCase().includes('remote') || location === '',
          employment_type: 'full-time',
          description: description
            .replace(/<[^>]*>/g, ' ') // strip HTML tags
            .replace(/\s+/g, ' ') // normalize whitespace
            .trim(),
          url,
          source: 'greenhouse' as const,
          scraped_at: new Date().toISOString(),
          posted_at: job.updated_at ?? job.first_published,
        });
      }

      console.log(`    ${companyName}: ${data.jobs.length} total → ${jobs.length} relevant`);

      return jobs;
    } catch (err) {
      console.log(`    ${companyName}: fetch failed — ${(err as Error).message}`);
      return [];
    } finally {
      // be polite — small delay between companies
      await sleep(300);
    }
  }
}
