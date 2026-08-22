import { describe, it, expect } from 'vitest';
import { QuickRejectService } from '../scoring/quick-reject.service';

const quickRejectService = new QuickRejectService();
const quickReject = quickRejectService.quickReject.bind(quickRejectService) as (job: {
  title: string;
  description: string;
}) => string | null;

describe('quickReject', () => {
  describe('title-based rejections', () => {
    it('rejects frontend roles', () => {
      expect(quickReject({ title: 'Frontend Engineer', description: '' })).toContain('frontend');
    });

    it('rejects data scientists', () => {
      expect(quickReject({ title: 'Data Scientist', description: '' })).toContain('data scientist');
    });

    it('rejects product managers', () => {
      expect(quickReject({ title: 'Product Manager', description: '' })).toContain('product manager');
    });

    it('rejects junior roles', () => {
      expect(quickReject({ title: 'Junior Developer', description: '' })).toContain('junior');
    });

    it('rejects QA engineers', () => {
      expect(quickReject({ title: 'QA Engineer', description: '' })).toContain('qa engineer');
    });

    it('accepts backend engineer', () => {
      expect(quickReject({ title: 'Senior Backend Engineer', description: '' })).toBeNull();
    });

    it('accepts software engineer', () => {
      expect(quickReject({ title: 'Software Engineer', description: '' })).toBeNull();
    });

    it('rejects staff engineer', () => {
      expect(quickReject({ title: 'Staff Software Engineer', description: '' })).toContain('staff');
    });

    it('rejects principal engineer', () => {
      expect(quickReject({ title: 'Principal Engineer', description: '' })).toContain('principal');
    });

    it('accepts full stack', () => {
      expect(quickReject({ title: 'Full Stack Engineer', description: '' })).toBeNull();
    });
  });

  describe('stack-based rejections', () => {
    it('rejects Java-heavy descriptions', () => {
      const result = quickReject({
        title: 'Software Engineer',
        description: 'Experience with java spring boot and jvm required',
      });
      expect(result).toContain('Java/JVM');
    });

    it('rejects .NET descriptions', () => {
      const result = quickReject({
        title: 'Software Engineer',
        description: 'Strong c# and asp.net experience needed',
      });
      expect(result).toContain('.NET/C#');
    });

    it('accepts Node.js/TypeScript descriptions', () => {
      const result = quickReject({
        title: 'Software Engineer',
        description: 'Build services with Node.js, TypeScript, and MongoDB',
      });
      expect(result).toBeNull();
    });

    it('does not reject with only 1 stack signal', () => {
      const result = quickReject({
        title: 'Software Engineer',
        description: 'Some java experience helpful',
      });
      expect(result).toBeNull();
    });
  });
});
