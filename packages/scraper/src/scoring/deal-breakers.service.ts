import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { JobListing } from '../types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const profile = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../profile/candidate.json'), 'utf-8'),
);

// ── Location classification ───────────────────────────────────────
// Full state names plus D.C. and the territories that use US postal codes.
const US_STATES = [
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware',
  'florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky',
  'louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi',
  'missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico',
  'new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania',
  'rhode island','south carolina','south dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west virginia','wisconsin','wyoming',
  'district of columbia','puerto rico',
];

// Two-letter codes are only trusted directly after a comma — the "City, ST"
// convention. Bare matching would be a minefield: OR/IN/ME/HI/OK/DE/LA are all
// ordinary words, and ", Canada" starts with the letters "ca".
const US_STATE_CODES = [
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la',
  'me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok',
  'or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy','dc','pr',
];
const US_STATE_CODE_RE = new RegExp(`,\\s*(${US_STATE_CODES.join('|')})\\b`, 'i');

const US_COUNTRY_MARKERS = ['united states', 'usa', 'u.s.a', 'u.s.', 'us-based', 'us only'];

// "US" as a standalone word — "Remote US", "Remote (US)", "US / Canada". Word
// boundaries keep it off the tail of Belarus, Aarhus, various, campus.
const US_TOKEN_RE = /\bus\b/i;

// Country names that collide with a US state name. Georgia is the only real
// one, and its cities disambiguate it.
const NON_US_HOMONYM_CITIES = ['tbilisi', 'batumi'];

function isUsLocation(loc: string): boolean {
  if (NON_US_HOMONYM_CITIES.some((c) => loc.includes(c))) return false;
  if (US_COUNTRY_MARKERS.some((m) => loc.includes(m))) return true;
  if (US_TOKEN_RE.test(loc)) return true;
  if (US_STATE_CODE_RE.test(loc)) return true;
  return US_STATES.some((st) => new RegExp(`\\b${st}\\b`).test(loc));
}

// No location signal either way — a bare "Remote" or "Anywhere". Kept rather
// than rejected: losing a real US role is worse than surfacing one to review.
function isLocationAmbiguous(loc: string): boolean {
  const t = loc.trim();
  return t === 'remote' || t === 'anywhere' || t === 'global' || t === 'flexible';
}

@Injectable()
export class DealBreakerService {
  checkDealBreakers(job: JobListing): { rejected: boolean; reason?: string } {
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

    // Rule 4 — keep US roles, reject everything outside the US.
    //
    // This is now the *only* location check: the API scrapers used to gate on a
    // 13-city US whitelist before a posting ever reached here, which silently
    // dropped real US roles in cities that weren't on it (Bellevue, Menlo Park,
    // Charlotte, D.C.).
    //
    // Detection is positive rather than a blacklist, because a blacklist can
    // only reject countries someone remembered to list — Serbia, Denmark,
    // Switzerland and Slovenia were all slipping through. US *states* are a
    // closed set of 51, unlike cities, so matching them covers every US posting
    // that names one.
    const loc = (job.location ?? '').toLowerCase();
    if (isUsLocation(loc)) return { rejected: false };
    if (loc.trim().length > 0 && !isLocationAmbiguous(loc)) {
      return {
        rejected: true,
        reason: `Location outside US: ${job.location}`,
      };
    }

    return { rejected: false };
  }
}
