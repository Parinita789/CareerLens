import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the profile file read before importing
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs') as any;
  return {
    ...actual,
    readFileSync: (path: string, ...args: any[]) => {
      if (path.includes('candidate.json')) {
        return JSON.stringify({
          compensation: { base_salary_min: 150000 },
          preferences: { employment_type: ['Full-time'] },
        });
      }
      return actual.readFileSync(path, ...args);
    },
  };
});

import { DealBreakerService } from '../scoring/deal-breakers.service';

const dealBreakerService = new DealBreakerService();
const checkDealBreakers = dealBreakerService.checkDealBreakers.bind(dealBreakerService);

const baseJob = {
  id: 'test',
  title: 'Senior Backend Engineer',
  company: 'TestCo',
  url: 'https://example.com',
  description: 'Build backend services with Node.js and TypeScript',
  source: 'greenhouse' as const,
  location: 'San Francisco, CA',
  remote: false,
  employment_type: 'Full-time',
  scraped_at: new Date().toISOString(),
};

describe('checkDealBreakers', () => {
  describe('salary floor', () => {
    it('rejects when salary too low', () => {
      const result = checkDealBreakers({ ...baseJob, salary_max: 100000 });
      expect(result.rejected).toBe(true);
      expect(result.reason).toContain('Salary too low');
    });

    it('accepts when salary meets minimum', () => {
      const result = checkDealBreakers({ ...baseJob, salary_max: 200000 });
      expect(result.rejected).toBe(false);
    });

    it('accepts when no salary listed', () => {
      const result = checkDealBreakers({ ...baseJob, salary_max: undefined });
      expect(result.rejected).toBe(false);
    });
  });

  describe('employment type', () => {
    it('rejects contract roles', () => {
      const result = checkDealBreakers({ ...baseJob, employment_type: 'Contract' });
      expect(result.rejected).toBe(true);
      expect(result.reason).toContain('Employment type');
    });

    it('accepts full-time', () => {
      const result = checkDealBreakers({ ...baseJob, employment_type: 'Full-time' });
      expect(result.rejected).toBe(false);
    });
  });

  describe('frontend-heavy detection', () => {
    it('rejects pure frontend role with 3+ signals', () => {
      const result = checkDealBreakers({
        ...baseJob,
        title: 'Frontend Engineer',
        description: 'frontend engineer role, css specialist needed, figma experience, pixel-perfect designs',
      });
      expect(result.rejected).toBe(true);
      expect(result.reason).toContain('Frontend-heavy');
    });

    it('accepts full stack with frontend signals', () => {
      const result = checkDealBreakers({
        ...baseJob,
        title: 'Full Stack Engineer',
        description: 'frontend engineer skills, css specialist, figma required',
      });
      expect(result.rejected).toBe(false);
    });

    it('accepts backend with few frontend signals', () => {
      const result = checkDealBreakers({
        ...baseJob,
        description: 'Some figma knowledge helpful but mainly backend Node.js',
      });
      expect(result.rejected).toBe(false);
    });
  });

  describe('location outside US', () => {
    it('rejects India location', () => {
      const result = checkDealBreakers({ ...baseJob, location: 'Bangalore, India' });
      expect(result.rejected).toBe(true);
      expect(result.reason).toContain('Location outside US');
    });

    it('rejects UK location', () => {
      const result = checkDealBreakers({ ...baseJob, location: 'London, United Kingdom' });
      expect(result.rejected).toBe(true);
    });

    it('accepts US location', () => {
      const result = checkDealBreakers({ ...baseJob, location: 'San Francisco, CA' });
      expect(result.rejected).toBe(false);
    });

    it('accepts United States explicit', () => {
      const result = checkDealBreakers({ ...baseJob, location: 'Remote, United States' });
      expect(result.rejected).toBe(false);
    });

    it('accepts US remote', () => {
      const result = checkDealBreakers({ ...baseJob, location: 'Remote US' });
      expect(result.rejected).toBe(false);
    });
  });

  // The API scrapers used to gate on a 13-city US whitelist before a posting
  // ever reached this rule, silently dropping real US roles in unlisted cities.
  // That gate is gone, so this rule now decides every location on its own.
  describe('US detection (sole location gate)', () => {
    const keep = (location: string) =>
      !checkDealBreakers({ ...baseJob, location }).rejected;

    it.each([
      // dropped by the old city whitelist despite being US
      'Bellevue, Washington', 'Bellevue, WA', 'Menlo Park, CA', 'Charlotte, NC', 'USA',
      'Bellevue, WA; Menlo Park, CA', 'Maryland; Virginia; Washington, D.C.',
      // US metros the old whitelist never listed
      'Atlanta, GA', 'Portland, OR', 'San Diego, CA', 'Nashville, TN', 'Dallas, TX',
      'Philadelphia, PA', 'Phoenix, AZ', 'Raleigh, NC', 'Salt Lake City, UT',
      'Miami, FL', 'Detroit, MI', 'Pittsburgh, PA',
    ])('keeps US location %s', (loc) => {
      expect(keep(loc)).toBe(true);
    });

    it.each([
      // these four leaked through the previous country blacklist
      'Belgrade, Serbia', 'Aarhus, Denmark', 'Zurich, Switzerland', 'Ljubljana, Slovenia',
      // never listed anywhere
      'Lisbon, Portugal', 'Prague, Czech Republic', 'Vienna, Austria',
      'Helsinki, Finland', 'Seoul, South Korea', 'Dubai, UAE',
      // already handled, must stay handled
      'Bengaluru, India', 'Amsterdam, Netherlands', 'Toronto, Canada',
      'Vancouver, British Columbia, Canada', 'Berlin, Germany', 'Tokyo, Japan',
    ])('rejects non-US location %s', (loc) => {
      expect(keep(loc)).toBe(false);
    });

    it.each([
      // two-letter state codes are only trusted after a comma, because OR / IN /
      // ME / HI / DE / LA are ordinary words and ", Canada" begins with "ca"
      ['Remote or Hybrid', 'OR would match Oregon'],
      ['Somewhere in Europe', 'IN would match Indiana'],
      ['Ontario, Canada', '", ca" would match California'],
      ['Tbilisi, Georgia', 'Georgia is also a US state'],
    ])('does not mistake %s for US (%s)', (loc) => {
      expect(keep(loc)).toBe(false);
    });

    it.each(['Remote', 'Anywhere', ''])(
      'keeps ambiguous location %s rather than risk losing a US role',
      (loc) => {
        expect(keep(loc)).toBe(true);
      },
    );
  });
});
