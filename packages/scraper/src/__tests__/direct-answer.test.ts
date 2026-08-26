import { describe, it, expect } from 'vitest';
import { DirectAnswerService } from '../answer-resolution/direct-answer.service';

const svc = new DirectAnswerService();
const profile = {
  personal: { name: 'Parinita Kumari', email: 'p@example.com', phone: '+1 555' },
  experience: { total_years: 7, current_level: 'Senior Backend Engineer' },
  compensation: { base_salary_preferred: 180000, base_salary_min: 150000 },
};

// Dropdowns are where these questions actually appear on EEO forms.
const ask = (label: string) => svc.getDirectAnswer('', label, profile, 'select');

describe('getDirectAnswer — demographics', () => {
  // These are substring tests, so a narrower question containing a broader
  // token must win. Each of these returned the wrong answer before.
  describe('substring collisions', () => {
    it('does not answer a transgender question with a gender value', () => {
      // "transgender" contains "gender" — this used to return "Female"
      expect(ask('Do you identify as transgender?')).toBe('No');
      expect(ask('Transgender Status')).toBe('No');
    });

    it('does not answer a first-generation question with a university name', () => {
      // "first-generation college student" contains "college" — used to return
      // "DIT University"
      expect(ask('Are you a first-generation college student?')).toBe('No');
      expect(ask('Are you first generation to attend university?')).toBe('No');
    });
  });

  describe('questions that previously went unanswered during live apply', () => {
    it('answers a bare "I identify as:" as gender identity', () => {
      expect(ask('I identify as:')).toBe('Cisgender');
    });

    it('answers Hispanic/Latino', () => {
      expect(ask('Are you Hispanic or Latino?')).toBe('No');
      expect(ask('Hispanic/Latino?')).toBe('No');
    });
  });

  describe('"identify as" must not hijack the other self-ID questions', () => {
    it.each([
      ['I identify as one or more of the classifications of protected veteran', 'No'],
      ['I identify my race/ethnicity as:', 'Asian'],
      ['I identify my sexual orientation as:', 'Heterosexual'],
      ['I identify as having a disability', 'No'],
    ])('%s -> %s', (label, expected) => {
      expect(ask(label)).toBe(expected);
    });
  });

  describe('the ordinary cases still work', () => {
    it.each([
      ['Gender', 'Female'],
      ['I identify my gender as:', 'Woman'],
      ['Race/Ethnicity', 'Asian'],
      ['Veteran Status:', 'No'],
      ['I have a disability:', 'No'],
      ['What are your pronouns?', 'She/Her'],
      ['Which university did you attend?', 'DIT University'],
    ])('%s -> %s', (label, expected) => {
      expect(ask(label)).toBe(expected);
    });
  });

  describe('never returns the checkbox default', () => {
    // The rules DB had 29 entries whose answer was the literal "on", written by
    // the capture pass. Nothing here should ever produce that.
    it.each([
      'Gender',
      'Race/Ethnicity',
      'Do you identify as transgender?',
      'Are you Hispanic or Latino?',
      'I identify as:',
    ])('%s', (label) => {
      expect(String(ask(label)).toLowerCase()).not.toBe('on');
    });
  });
});
