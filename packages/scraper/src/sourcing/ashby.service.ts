import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import type { JobListing } from '../types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRelevantRole(title: string, description: string, location: string): boolean {
  const t = title.toLowerCase();
  const d = description.toLowerCase();
  const loc = location.toLowerCase();

  // Hard excludes on title
  const titleExcludes = [
    'frontend', 'front-end', 'ios ', 'android', 'data scientist',
    'machine learning engineer', 'designer', 'ux ', 'product manager',
    ' pm ', 'sales ', 'recruiter', 'marketing', 'finance', 'legal',
    'test engineer', 'sdet', 'qa engineer', 'devrel', 'developer advocate',
    'embedded', 'firmware', 'hardware', 'data analyst', 'analytics engineer',
    'junior', 'intern ', 'php developer', 'ruby developer', '.net developer',
    'java developer',
  ];
  if (titleExcludes.some((k) => t.includes(k))) return false;

  // Must be a software/backend/platform role
  const roleTitles = [
    'software engineer', 'software developer', 'backend engineer', 'back-end engineer',
    'platform engineer', 'fullstack', 'full stack',
    'senior engineer', 'senior developer', 'engineer ii', 'engineer iii', 'engineer iv',
    'api engineer', 'infrastructure engineer', 'engineer,', 'engineer -',
  ];
  if (!roleTitles.some((k) => t.includes(k))) return false;

  // Tech check — title OR description (2+ matches in description)
  const techSignals = [
    'node', 'typescript', 'javascript', 'golang', ' go ', 'nestjs', 'express',
    'microservice', 'distributed', 'event-driven', 'api', 'rest', 'graphql',
    'aws', 'gcp', 'azure', 'cloud', 'docker', 'kubernetes', 'k8s',
    'mongodb', 'postgresql', 'postgres', 'redis', 'kafka', 'rabbitmq',
    'backend', 'back-end', 'server-side', 'scalab', 'distributed system',
  ];
  const titleHasTech = techSignals.some((k) => t.includes(k));
  const descHasTech = techSignals.filter((k) => d.includes(k)).length >= 2;
  if (!titleHasTech && !descHasTech) return false;

  // Location filter — US/remote only
  const usSignals = [
    'remote', 'hybrid', 'distributed', 'united states', 'us only', 'us-based',
    'anywhere', 'san francisco', 'new york', 'seattle', 'austin', 'los angeles',
    'denver', 'chicago', 'boston', 'california', 'bay area',
  ];
  return location === '' || usSignals.some((k) => loc.includes(k));
}

@Injectable()
export class AshbyService {
  async scrapeAshby(companySlug: string, companyName: string): Promise<JobListing[]> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${companySlug}`;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          console.log(`    ${companyName}: Ashby board not found (slug may be wrong)`);
          return [];
        }
        console.log(`    ${companyName}: Ashby API returned ${response.status}`);
        return [];
      }

      const data = (await response.json()) as { jobs: any[] };

      if (!data.jobs?.length) {
        console.log(`    ${companyName}: no open positions`);
        return [];
      }

      const jobs: JobListing[] = [];

      for (const job of data.jobs) {
        if (!job.isListed) continue;

        const title = job.title ?? '';
        const location = job.location ?? '';
        const description = job.descriptionPlain ?? '';
        const jobUrl = job.jobUrl ?? '';

        if (!isRelevantRole(title, description, location)) continue;

        jobs.push({
          id: crypto
            .createHash('md5')
            .update(`ashby-${companySlug}-${job.id}`)
            .digest('hex')
            .slice(0, 10),
          title,
          company: companyName,
          location,
          remote: job.isRemote || job.workplaceType === 'Remote',
          employment_type: job.employmentType === 'FullTime' ? 'Full-time' : job.employmentType || 'Full-time',
          description: description
            .replace(/\s+/g, ' ')
            .trim(),
          url: jobUrl,
          source: 'ashby' as const,
          scraped_at: new Date().toISOString(),
          posted_at: job.publishedAt,
        });
      }

      console.log(`    ${companyName}: ${data.jobs.length} total → ${jobs.length} relevant`);

      return jobs;
    } catch (err) {
      console.log(`    ${companyName}: Ashby fetch failed — ${(err as Error).message}`);
      return [];
    } finally {
      await sleep(300);
    }
  }
}
