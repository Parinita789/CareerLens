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
});
