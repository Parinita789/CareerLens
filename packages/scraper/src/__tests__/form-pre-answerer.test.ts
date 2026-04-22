import { describe, it, expect } from 'vitest';
import { getProfileAnswer, matchRule, matchOption } from '../scraper/form-pre-answerer';

const mockProfile = {
  personal: {
    name: 'Parinita Kumari',
    email: 'test@example.com',
    phone: '+1 669-367-1049',
    location: 'San Jose, CA, USA',
    linkedin: 'https://linkedin.com/in/test',
    github: 'https://github.com/test',
  },
  preferences: {
    location: { current_city: 'San Jose, CA, USA' },
  },
  compensation: {
    base_salary_preferred: 180000,
  },
  experience: {
    total_years: 7,
    current_level: 'Backend Engineer',
  },
  work_history: [
    { company: 'Ninox Software GmbH' },
    { company: 'Nium' },
    { company: 'Driver Bandhu' },
  ],
};

// ── getProfileAnswer ──

describe('getProfileAnswer', () => {
  describe('identity fields', () => {
    it('returns first name', () => {
      expect(getProfileAnswer('First Name', mockProfile)).toBe('Parinita');
    });

    it('returns last name', () => {
      expect(getProfileAnswer('Last Name', mockProfile)).toBe('Kumari');
    });

    it('returns full name', () => {
      expect(getProfileAnswer('Full Name', mockProfile)).toBe('Parinita Kumari');
    });

    it('returns email', () => {
      expect(getProfileAnswer('Email', mockProfile)).toBe('test@example.com');
    });

    it('returns phone', () => {
      expect(getProfileAnswer('Phone', mockProfile)).toBe('+1 669-367-1049');
    });

    it('returns linkedin', () => {
      expect(getProfileAnswer('LinkedIn Profile', mockProfile)).toBe('https://linkedin.com/in/test');
    });

    it('returns github for exact match', () => {
      expect(getProfileAnswer('GitHub', mockProfile)).toBe('https://github.com/test');
    });

    it('leaves twitter empty', () => {
      expect(getProfileAnswer('Twitter', mockProfile)).toBe('');
    });

    it('leaves other links empty', () => {
      expect(getProfileAnswer('Other Links', mockProfile)).toBe('');
    });

    it('returns preferred name as first name', () => {
      expect(getProfileAnswer('Preferred Name', mockProfile)).toBe('Parinita');
    });
  });

  describe('yes/no questions', () => {
    it('returns Yes for work authorization', () => {
      expect(getProfileAnswer('Are you authorized to work in the US?', mockProfile)).toBe('Yes');
    });

    it('returns Yes for eligibility', () => {
      expect(getProfileAnswer('Are you eligible to work in the United States?', mockProfile)).toBe('Yes');
    });

    it('returns No for sponsorship', () => {
      expect(getProfileAnswer('Do you require visa sponsorship?', mockProfile)).toBe('No');
    });

    it('returns No for sponsor you pattern', () => {
      expect(getProfileAnswer('Will you require Stripe to sponsor you for a work permit?', mockProfile)).toBe('No');
    });

    it('returns No for work permit + require', () => {
      expect(getProfileAnswer('Do you require a work permit now or in the future?', mockProfile)).toBe('No');
    });

    it('returns Yes for relocation', () => {
      expect(getProfileAnswer('Are you willing to relocate?', mockProfile)).toBe('Yes');
    });

    it('returns Yes for background check', () => {
      expect(getProfileAnswer('Are you ok with a background check?', mockProfile)).toBe('Yes');
    });

    it('returns Yes for hybrid/onsite', () => {
      expect(getProfileAnswer('Can you commute to our office?', mockProfile)).toBe('Yes');
      expect(getProfileAnswer('Are you available for hybrid work?', mockProfile)).toBe('Yes');
      expect(getProfileAnswer('Can you work on-site?', mockProfile)).toBe('Yes');
    });

    it('returns Yes for remote plan', () => {
      expect(getProfileAnswer('Do you plan to work remotely?', mockProfile)).toBe('Yes');
    });

    it('returns Yes for consent', () => {
      expect(getProfileAnswer('By checking this box, I consent to data collection', mockProfile)).toBe('Yes');
      expect(getProfileAnswer('I acknowledge the privacy policy', mockProfile)).toBe('Yes');
    });

    it('returns Yes for opt-in', () => {
      expect(getProfileAnswer('Do you opt-in to receive WhatsApp messages?', mockProfile)).toBe('Yes');
    });

    it('returns No for hispanic/latino', () => {
      expect(getProfileAnswer('Are you Hispanic/Latino?', mockProfile)).toBe('No');
    });
  });

  describe('employment history', () => {
    it('returns No for company not in history', () => {
      expect(getProfileAnswer('Have you ever been employed by Stripe?', mockProfile, 'Stripe')).toBe('No');
    });

    it('returns Yes for company in history', () => {
      expect(getProfileAnswer('Have you worked for Nium before?', mockProfile, 'Nium')).toBe('Yes');
    });

    it('returns No for worked at unknown company', () => {
      expect(getProfileAnswer('Have you worked at Google?', mockProfile, 'Google')).toBe('No');
    });
  });

  describe('demographics', () => {
    it('returns Woman for gender + identify', () => {
      expect(getProfileAnswer('I identify my gender as:', mockProfile)).toBe('Woman');
    });

    it('returns Female for plain gender', () => {
      expect(getProfileAnswer('Gender', mockProfile)).toBe('Female');
    });

    it('returns Cisgender for generic identify as', () => {
      expect(getProfileAnswer('I identify as:', mockProfile)).toBe('Cisgender');
    });

    it('returns No for transgender', () => {
      expect(getProfileAnswer('I identify as transgender', mockProfile)).toBe('No');
    });

    it('returns Asian for race', () => {
      expect(getProfileAnswer('Race', mockProfile)).toBe('Asian');
    });

    it('returns Asian for ethnicity', () => {
      expect(getProfileAnswer('Please identify your race/ethnicity', mockProfile)).toBe('Asian');
    });

    it('returns No for veteran', () => {
      expect(getProfileAnswer('Veteran Status', mockProfile)).toBe('No');
    });

    it('returns No for disability', () => {
      expect(getProfileAnswer('Disability Status', mockProfile)).toBe('No');
    });

    it('returns Heterosexual for sexual orientation', () => {
      expect(getProfileAnswer('Sexual Orientation', mockProfile)).toBe('Heterosexual');
    });

    it('returns She/Her for pronouns', () => {
      expect(getProfileAnswer('Pronouns', mockProfile)).toBe('She/Her');
    });

    it('returns No for first generation', () => {
      expect(getProfileAnswer('Are you a first-generation professional?', mockProfile)).toBe('No');
    });
  });

  describe('location', () => {
    it('returns United States for country', () => {
      expect(getProfileAnswer('Country', mockProfile)).toBe('United States');
    });

    it('returns United States for country in long label', () => {
      expect(getProfileAnswer('Please select the country where you currently reside', mockProfile)).toBe('United States');
    });

    it('does not match country for sponsorship questions with location', () => {
      const result = getProfileAnswer('Will you require sponsorship for the location(s) you selected?', mockProfile);
      expect(result).toBe('No'); // should match sponsorship, not location
    });

    it('returns city without USA suffix', () => {
      expect(getProfileAnswer('City', mockProfile)).toBe('San Jose, CA');
    });

    it('returns California for state', () => {
      expect(getProfileAnswer('State', mockProfile)).toBe('California');
    });
  });

  describe('work fields', () => {
    it('returns salary', () => {
      expect(getProfileAnswer('Expected Salary', mockProfile)).toBe('180000');
    });

    it('returns years of experience', () => {
      expect(getProfileAnswer('Total years of experience', mockProfile)).toBe('7');
    });

    it('returns current title', () => {
      expect(getProfileAnswer('Current Job Title', mockProfile)).toBe('Backend Engineer');
    });

    it('returns Full-time for employment type', () => {
      expect(getProfileAnswer('Employment Type', mockProfile)).toBe('Full-time');
    });

    it('returns LinkedIn for how did you hear', () => {
      expect(getProfileAnswer('How did you hear about us?', mockProfile)).toBe('LinkedIn');
    });
  });

  describe('returns null for unknown', () => {
    it('returns null for unrecognized label', () => {
      expect(getProfileAnswer('Favorite color?', mockProfile)).toBeNull();
    });
  });
});

// ── matchRule ──

describe('matchRule', () => {
  const rules = {
    'authorized to work': 'Yes',
    'visa sponsorship': 'No',
    'years of experience': '7',
    'security clearance': 'No',
  };

  it('matches substring in normalized label', () => {
    expect(matchRule('Are you authorized to work in the US?', rules)).toBe('Yes');
  });

  it('matches with different casing', () => {
    expect(matchRule('VISA SPONSORSHIP required?', rules)).toBe('No');
  });

  it('matches with punctuation stripped', () => {
    expect(matchRule("How many years of experience do you have?", rules)).toBe('7');
  });

  it('returns null for no match', () => {
    expect(matchRule('What is your shoe size?', rules)).toBeNull();
  });

  it('returns first matching rule', () => {
    const overlapping = { 'work': 'A', 'authorized to work': 'B' };
    expect(matchRule('Are you authorized to work?', overlapping)).toBe('A'); // 'work' matches first
  });
});

// ── matchOption ──

describe('matchOption', () => {
  it('returns answer as-is when no options', () => {
    expect(matchOption('test', [])).toBe('test');
  });

  describe('exact match', () => {
    it('matches exact case-insensitive', () => {
      expect(matchOption('Yes', ['Yes', 'No'])).toBe('Yes');
      expect(matchOption('yes', ['Yes', 'No'])).toBe('Yes');
    });
  });

  describe('race/ethnicity — South Asian preference', () => {
    it('prefers South Asian over East Asian', () => {
      const opts = ['East Asian', 'South Asian', 'Central Asian'];
      expect(matchOption('Asian', opts)).toBe('South Asian');
    });

    it('matches exact Asian when no South Asian', () => {
      const opts = ['Asian', 'White', 'Black'];
      expect(matchOption('Asian', opts)).toBe('Asian');
    });

    it('returns South Asian for south asian input', () => {
      const opts = ['Central Asian', 'South Asian (inclusive of...)', 'East Asian'];
      expect(matchOption('South Asian', opts)).toBe('South Asian (inclusive of...)');
    });
  });

  describe('gender', () => {
    it('matches Female to Woman', () => {
      expect(matchOption('Female', ['Man', 'Woman', 'Non-binary'])).toBe('Woman');
    });

    it('matches Woman to Female', () => {
      expect(matchOption('Woman', ['Male', 'Female', 'Other'])).toBe('Female');
    });
  });

  describe('gender identity / sexual orientation', () => {
    it('matches Heterosexual to Straight', () => {
      expect(matchOption('Heterosexual', ['Gay', 'Straight', 'Bisexual'])).toBe('Straight');
    });

    it('matches Straight to Heterosexual', () => {
      expect(matchOption('Straight', ['Heterosexual', 'Gay'])).toBe('Heterosexual');
    });

    it('matches Cisgender', () => {
      expect(matchOption('Cisgender', ['Cisgender', 'Transgender'])).toBe('Cisgender');
    });

    it('matches Straight to Straight/Heterosexual', () => {
      expect(matchOption('Heterosexual', ['Straight/Heterosexual', 'Bisexual'])).toBe('Straight/Heterosexual');
    });
  });

  describe('country aliases', () => {
    it('matches United States to US', () => {
      expect(matchOption('United States', ['US', 'UK', 'India'])).toBe('US');
    });

    it('matches US to USA', () => {
      expect(matchOption('US', ['USA', 'UK'])).toBe('USA');
    });

    it('matches United States to United States of America', () => {
      expect(matchOption('United States', ['United States of America', 'Canada'])).toBe('United States of America');
    });
  });

  describe('yes/no', () => {
    it('matches Yes to long yes option', () => {
      expect(matchOption('Yes', ['Yes, I am authorized to work', 'No'])).toBe('Yes, I am authorized to work');
    });

    it('matches No to long no option', () => {
      expect(matchOption('No', ['Yes', 'No, I will not require sponsorship'])).toBe('No, I will not require sponsorship');
    });

    it('matches Yes to positive phrasing', () => {
      expect(matchOption('Yes', ['I am authorized', 'I am not authorized'])).toBe('I am authorized');
    });

    it('matches No to negative phrasing', () => {
      expect(matchOption('No', ['I do not require', 'I require'])).toBe('I do not require');
    });
  });
});
