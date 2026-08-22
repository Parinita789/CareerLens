import { Injectable } from '@nestjs/common';
import { TARGET_COMPANIES } from '../../common/company-directory';
import type { ScoredJob } from '../../types';

@Injectable()
export class GreenhouseUrlResolverService {
  // Build direct Greenhouse application URL from job data
  getGreenhouseDirectUrl(job: ScoredJob): string | null {
    // Extract gh_jid from URL like ?gh_jid=7091959
    const ghJidMatch = job.url.match(/gh_jid=(\d+)/);
    if (!ghJidMatch) {
      // Already a greenhouse URL like job-boards.greenhouse.io/stripe/jobs/123
      if (job.url.includes('greenhouse.io')) return job.url;
      return null;
    }

    const jobId = ghJidMatch[1];

    // Find company slug from TARGET_COMPANIES
    const company = TARGET_COMPANIES.find((c) => c.name.toLowerCase() === job.company.toLowerCase());

    if (company) {
      return `https://job-boards.greenhouse.io/${company.slug}/jobs/${jobId}`;
    }

    // Fallback: try lowercase company name as slug
    const slugGuess = job.company.toLowerCase().replace(/[^a-z0-9]/g, '');
    return `https://job-boards.greenhouse.io/${slugGuess}/jobs/${jobId}`;
  }
}
