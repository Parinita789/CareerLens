import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import type { JobListing } from '../types';
import { isRelevantRole } from '../common/role-filter';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


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

        if (!isRelevantRole(title, description)) continue;

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
