import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { JobListing } from './types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const profile = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../profile/candidate.json'), 'utf-8'),
);

export function checkDealBreakers(job: JobListing): { rejected: boolean; reason?: string } {
  // Rule 1 — salary floor (only if salary is explicitly listed)
  if (job.salary_max !== undefined && job.salary_max < profile.compensation.base_salary_min) {
    return {
      rejected: true,
      reason: `Salary too low: $${job.salary_max.toLocaleString()} < minimum $${profile.compensation.base_salary_min.toLocaleString()}`,
    };
  }

  // Rule 2 — employment type (case-insensitive)
  const preferredTypes = profile.preferences.employment_type.map((t: string) => t.toLowerCase());
  if (!preferredTypes.includes((job.employment_type || '').toLowerCase())) {
    return {
      rejected: true,
      reason: `Employment type "${job.employment_type}" not preferred`,
    };
  }

  // Rule 3 — frontend-heavy detection
  const frontendSignals = [
    'frontend engineer',
    'front-end engineer',
    'css specialist',
    'figma',
    'pixel-perfect',
    'ui/ux engineer',
  ];
  const descLower = job.description.toLowerCase();
  const titleLower = job.title.toLowerCase();
  const isFullStack = titleLower.includes('full stack') || titleLower.includes('fullstack');
  const hits = frontendSignals.filter((kw) => descLower.includes(kw));
  if (hits.length >= 3 && !isFullStack) {
    return {
      rejected: true,
      reason: `Frontend-heavy role detected (${hits.join(', ')})`,
    };
  }

  // Rule 4 — location outside US
  const loc = job.location.toLowerCase();
  const nonUSIndicators = [
    'india',
    'uk',
    'united kingdom',
    'london',
    'germany',
    'berlin',
    'canada',
    'toronto',
    'vancouver',
    'australia',
    'sydney',
    'melbourne',
    'singapore',
    'japan',
    'tokyo',
    'france',
    'paris',
    'netherlands',
    'amsterdam',
    'ireland',
    'dublin',
    'israel',
    'tel aviv',
    'brazil',
    'são paulo',
    'mexico',
    'spain',
    'madrid',
    'barcelona',
    'sweden',
    'stockholm',
    'poland',
    'warsaw',
    'romania',
    'bucharest',
    'ukraine',
    'china',
    'beijing',
    'shanghai',
    'south korea',
    'seoul',
    'argentina',
    'buenos aires',
    'colombia',
    'bogota',
    'chile',
    'santiago',
    'nigeria',
    'lagos',
    'kenya',
    'nairobi',
    'south africa',
    'cape town',
    'egypt',
    'cairo',
  ];
  const isRemote = loc.includes('remote') && !loc.includes('us') && !loc.includes('united states');
  const isNonUS = nonUSIndicators.some((c) => loc.includes(c));
  if (isNonUS && !loc.includes('united states') && !loc.includes(' us') && !loc.includes('usa')) {
    return {
      rejected: true,
      reason: `Location outside US: ${job.location}`,
    };
  }

  return { rejected: false };
}
