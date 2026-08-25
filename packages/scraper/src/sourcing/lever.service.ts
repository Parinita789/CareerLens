import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import type { JobListing } from '../types';
import { isRelevantRole } from '../common/role-filter';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


@Injectable()
export class LeverService {
  async scrapeLever(companySlug: string, companyName: string): Promise<JobListing[]> {
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

        if (!isRelevantRole(title, description)) continue;

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
}
