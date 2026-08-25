import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import type { JobListing } from '../types';
import { isRelevantRole } from '../common/role-filter';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


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

        if (!isRelevantRole(title, description)) continue;

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
