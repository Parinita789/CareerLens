import { describe, it, expect } from 'vitest';
import { OptionMatcherService } from '../answer-resolution/option-matcher.service';

const optionMatcherService = new OptionMatcherService();
const smartMatchOption = optionMatcherService.smartMatchOption.bind(optionMatcherService);

describe('smartMatchOption', () => {
  describe('exact match', () => {
    it('matches exact text', () => {
      expect(smartMatchOption('Yes', ['Yes', 'No'], 'question')).toBe('Yes');
    });

    it('matches case-insensitive', () => {
      expect(smartMatchOption('yes', ['Yes', 'No'], 'question')).toBe('Yes');
    });
  });

  describe('contains match', () => {
    it('matches when option contains answer', () => {
      expect(smartMatchOption('Engineer', ['Software Engineer', 'Designer'], 'role')).toBe('Software Engineer');
    });

    it('matches when answer contains option', () => {
      expect(smartMatchOption('Senior Software Engineer', ['Software Engineer'], 'role')).toBe('Software Engineer');
    });
  });

  describe('country variations', () => {
    it('matches United States to US', () => {
      expect(smartMatchOption('United States', ['India', 'US', 'UK'], 'country')).toBe('US');
    });

    it('matches US to USA', () => {
      expect(smartMatchOption('US', ['USA', 'Canada'], 'country')).toBe('USA');
    });

    it('matches United States to United States of America', () => {
      expect(smartMatchOption('United States', ['Australia', 'United States of America'], 'country')).toBe('United States of America');
    });

    it('matches USA to U.S.A.', () => {
      expect(smartMatchOption('USA', ['U.S.A.', 'Canada'], 'country')).toBe('U.S.A.');
    });
  });

  describe('yes/no matching', () => {
    it('matches Yes to starts-with', () => {
      expect(smartMatchOption('Yes', ['Yes, I am authorized to work', 'No'], 'auth')).toBe('Yes, I am authorized to work');
    });

    it('matches No to starts-with', () => {
      expect(smartMatchOption('No', ['Yes', 'No, I will not require sponsorship'], 'visa')).toBe('No, I will not require sponsorship');
    });

    it('matches Yes to positive phrasing (I am)', () => {
      expect(smartMatchOption('Yes', ['I am eligible', 'I am not eligible'], 'eligible')).toBe('I am eligible');
    });

    it('matches Yes to I intend', () => {
      expect(smartMatchOption('Yes', ['Yes, I intend to work remotely.', 'No'], 'remote')).toBe('Yes, I intend to work remotely.');
    });

    it('matches No to negative phrasing (I am not)', () => {
      expect(smartMatchOption('No', ['I am a veteran', 'I am not a veteran'], 'veteran')).toBe('I am not a veteran');
    });

    it('matches No to I do not', () => {
      expect(smartMatchOption('No', ['I do not require', 'I require'], 'sponsor')).toBe('I do not require');
    });
  });

  describe('gender', () => {
    it('matches Female to Woman', () => {
      expect(smartMatchOption('Female', ['Man', 'Woman', 'Non-binary'], 'gender')).toBe('Woman');
    });

    it('matches Female to Female (she/her)', () => {
      expect(smartMatchOption('Female', ['Male', 'Female (she/her)', 'Other'], 'gender')).toBe('Female (she/her)');
    });

    it('matches Woman to Woman', () => {
      expect(smartMatchOption('Woman', ['Man', 'Woman'], 'gender')).toBe('Woman');
    });

    it('matches Male to Man', () => {
      expect(smartMatchOption('Male', ['Man', 'Woman'], 'gender')).toBe('Man');
    });

    it('matches Male — prefers Man over Female', () => {
      expect(smartMatchOption('Male', ['Female', 'Man'], 'gender')).toBe('Man');
    });
  });

  describe('gender identity', () => {
    it('matches Cisgender', () => {
      expect(smartMatchOption('Cisgender', ['Cisgender', 'Transgender'], 'identify')).toBe('Cisgender');
    });

    it('matches Heterosexual to Straight', () => {
      expect(smartMatchOption('Heterosexual', ['Straight', 'Gay'], 'orientation')).toBe('Straight');
    });

    it('matches Straight to Heterosexual', () => {
      expect(smartMatchOption('Straight', ['Heterosexual', 'Bisexual'], 'orientation')).toBe('Heterosexual');
    });

    it('matches Straight to Straight/Heterosexual', () => {
      expect(smartMatchOption('Heterosexual', ['Straight/Heterosexual', 'Bisexual'], 'orientation')).toBe('Straight/Heterosexual');
    });
  });

  describe('race/ethnicity', () => {
    it('prefers South Asian over East Asian', () => {
      const opts = ['Central Asian', 'East Asian', 'South Asian (inclusive of...)'];
      expect(smartMatchOption('Asian', opts, 'race')).toBe('South Asian (inclusive of...)');
    });

    it('matches Asian when no South Asian', () => {
      expect(smartMatchOption('Asian', ['Asian', 'White'], 'race')).toBe('Asian');
    });

    it('matches South Asian directly', () => {
      expect(smartMatchOption('South Asian', ['East Asian', 'South Asian'], 'race')).toBe('South Asian');
    });

    it('matches White/Caucasian', () => {
      expect(smartMatchOption('White', ['White', 'Asian'], 'race')).toBe('White');
      expect(smartMatchOption('Caucasian', ['White', 'Asian'], 'race')).toBe('White');
    });

    it('matches Black/African American', () => {
      expect(smartMatchOption('Black', ['Black or African American', 'White'], 'race')).toBe('Black or African American');
    });

    it('matches Hispanic/Latino', () => {
      expect(smartMatchOption('Hispanic', ['Hispanic or Latino', 'White'], 'race')).toBe('Hispanic or Latino');
    });

    it('generic race match via label context', () => {
      expect(smartMatchOption('Pacific Islander', ['Native Hawaiian or Pacific Islander', 'White'], 'Please identify your race')).toBe('Native Hawaiian or Pacific Islander');
    });
  });

  describe('veteran — label-aware', () => {
    it('matches No to I am not a protected veteran', () => {
      expect(smartMatchOption('No', ['I am a protected veteran', 'I am not a protected veteran', "I don't wish to answer"], 'Veteran Status')).toBe('I am not a protected veteran');
    });
  });

  describe('disability — label-aware', () => {
    it('matches No to do not have', () => {
      expect(smartMatchOption('No', ['Yes, I have a disability', 'No, I do not have a disability'], 'Disability Status')).toBe('No, I do not have a disability');
    });
  });

  describe('decline/prefer not', () => {
    it('matches decline', () => {
      expect(smartMatchOption('Decline', ['Yes', 'No', 'Decline to self identify'], 'gender')).toBe('Decline to self identify');
    });

    it('matches prefer not', () => {
      expect(smartMatchOption('Prefer not', ['Yes', 'Prefer not to say'], 'question')).toBe('Prefer not to say');
    });
  });

  describe('starts-with fallback', () => {
    it('matches starts-with when nothing else works', () => {
      expect(smartMatchOption('Bach', ["Bachelor's", "Master's"], 'degree')).toBe("Bachelor's");
    });
  });

  describe('no match', () => {
    it('returns null when nothing matches', () => {
      expect(smartMatchOption('Purple', ['Red', 'Blue', 'Green'], 'color')).toBeNull();
    });
  });
});
