import { Injectable } from '@nestjs/common';

@Injectable()
export class DirectAnswerService {
  // Labels that aren't real questions — skip these
  isSkippableLabel(label: string): boolean {
    const lower = label.toLowerCase().trim();
    const skip = [
      'attach',
      'upload',
      'drag',
      'drop',
      'browse',
      'choose file',
      'or',
      'and',
      'submit',
      'apply',
      'cancel',
      'back',
      'next',
      'required',
      'optional',
      'enter manually',
      'search',
      'select',
      'type to search',
    ];
    if (skip.includes(lower)) return true;
    if (lower.length < 2) return true;
    if (lower.length > 150) return true;
    // Skip if it's just a number or punctuation
    if (/^[\d\s\-_.*]+$/.test(lower)) return true;
    return false;
  }

  // Map known field IDs/labels to profile data — these should never go to LLM
  // fieldType: pass 'text' for text inputs, 'select'/'radio' for dropdowns
  getDirectAnswer(id: string, label: string, profile: any, fieldType: string = 'text'): string | null {
    const idLower = id.toLowerCase();
    const labelLower = label.toLowerCase();

    if (
      idLower === 'first_name' ||
      idLower === 'firstname' ||
      labelLower === 'first name' ||
      labelLower === 'first name'
    ) {
      return profile?.personal?.name?.split(' ')[0] || '';
    }
    if (
      idLower === 'last_name' ||
      idLower === 'lastname' ||
      labelLower === 'last name' ||
      labelLower === 'last name' ||
      labelLower === 'surname'
    ) {
      const parts = profile?.personal?.name?.split(' ') || [];
      return parts.slice(1).join(' ') || '';
    }
    if (idLower === 'name' || labelLower === 'name' || labelLower === 'full name') {
      return profile?.personal?.name || '';
    }
    if (
      idLower === 'preferred_name' ||
      idLower === 'preferredname' ||
      labelLower.includes('preferred')
    ) {
      return profile?.personal?.name?.split(' ')[0] || '';
    }
    if (idLower === 'email' || labelLower === 'email' || labelLower === 'email address') {
      return profile?.personal?.email || '';
    }
    if (idLower === 'phone' || labelLower === 'phone' || labelLower === 'phone number') {
      return profile?.personal?.phone || '';
    }
    if (labelLower.includes('linkedin')) {
      return profile?.personal?.linkedin || '';
    }
    if (
      labelLower.includes('website') ||
      labelLower.includes('github') ||
      labelLower.includes('portfolio') ||
      labelLower.includes('url')
    ) {
      return profile?.personal?.github || '';
    }

    // ── Work authorization (MUST be before location checks) ──
    // Only return Yes/No for non-text fields — text inputs with these labels are usually dropdowns
    if (fieldType !== 'text') {
      if (
        labelLower.includes('authorized to work') ||
        labelLower.includes('legally authorized') ||
        labelLower.includes('eligible to work') ||
        labelLower.includes('work authorization') ||
        labelLower.includes('right to work') ||
        labelLower.includes('legally eligible')
      ) {
        return 'Yes';
      }
      if (
        labelLower.includes('visa sponsorship') ||
        labelLower.includes('require sponsorship') ||
        labelLower.includes('need sponsorship') ||
        labelLower.includes('immigration sponsorship')
      ) {
        return 'No';
      }
    }

    // Location — require word boundaries on short keywords to avoid matching inside "ethniCITY" / "STATEs".
    if (
      /\bcity\b/.test(labelLower) ||
      labelLower.includes('location') ||
      labelLower.includes('address')
    ) {
      return profile?.preferences?.location?.current_city || profile?.personal?.location || '';
    }
    if (/\bstate\b/.test(labelLower) || /\bprovince\b/.test(labelLower)) {
      return 'California';
    }
    if (/\bzip\b/.test(labelLower) || labelLower.includes('postal')) {
      return '95134';
    }
    if (
      idLower === 'country' ||
      labelLower === 'country' ||
      (labelLower.includes('country') && !/\bcity\b/.test(labelLower))
    ) {
      return 'United States';
    }

    // ── Compensation ──
    if (
      labelLower.includes('salary') ||
      labelLower.includes('compensation') ||
      labelLower.includes('pay expectation') ||
      labelLower.includes('desired pay')
    ) {
      return String(profile?.compensation?.base_salary_preferred || '180000');
    }
    if (
      labelLower.includes('salary expectation') ||
      labelLower.includes('expected salary') ||
      labelLower.includes('minimum salary')
    ) {
      return String(profile?.compensation?.base_salary_min || '150000');
    }

    // ── Experience ──
    if (
      labelLower.includes('years of experience') ||
      labelLower.includes('total experience') ||
      labelLower.includes('how many years')
    ) {
      return String(profile?.experience?.total_years || '7');
    }
    if (
      labelLower.includes('current title') ||
      labelLower.includes('job title') ||
      labelLower.includes('current role')
    ) {
      return profile?.experience?.current_level || 'Backend Engineer';
    }
    if (
      labelLower.includes('current company') ||
      labelLower.includes('current employer') ||
      labelLower.includes('most recent company')
    ) {
      const latest = profile?.work_history?.[0];
      return latest?.company || '';
    }

    // ── Availability ──
    if (
      labelLower.includes('start date') ||
      labelLower.includes('when can you start') ||
      labelLower.includes('earliest start') ||
      labelLower.includes('available to start') ||
      labelLower.includes('notice period')
    ) {
      return '2 weeks';
    }

    // ── Questions that ALWAYS have a clear answer regardless of field type ──

    // Sponsorship / visa — always No
    if (
      labelLower.includes('require sponsorship') ||
      labelLower.includes('need sponsorship') ||
      labelLower.includes('require.*visa') ||
      labelLower.includes('sponsorship for employment') ||
      labelLower.includes('immigration sponsorship') ||
      labelLower.includes('visa sponsorship') ||
      labelLower.includes('visa status') ||
      labelLower.includes('require.*immigration')
    ) {
      return 'No';
    }

    // Work authorization — always Yes
    if (
      labelLower.includes('authorized to work') ||
      labelLower.includes('legally authorized') ||
      labelLower.includes('eligible to work') ||
      labelLower.includes('work authorization') ||
      labelLower.includes('right to work') ||
      labelLower.includes('legally eligible') ||
      labelLower.includes('legal right to work') ||
      labelLower.includes('work legally')
    ) {
      return 'Yes';
    }

    // Relocation — always Yes
    if (
      labelLower.includes('willing to relocate') ||
      labelLower.includes('open to relocation') ||
      labelLower.includes('relocate if') ||
      labelLower.includes('willing to move')
    ) {
      return 'Yes';
    }

    // Background check — always Yes
    if (
      labelLower.includes('background check') ||
      labelLower.includes('drug test') ||
      labelLower.includes('drug screen') ||
      labelLower.includes('consent to')
    ) {
      return 'Yes';
    }

    // Commute / in-person — always Yes
    if (
      labelLower.includes('able to commute') ||
      labelLower.includes('commute to') ||
      labelLower.includes('work in person') ||
      labelLower.includes('in-person') ||
      labelLower.includes('on-site') ||
      labelLower.includes('onsite') ||
      labelLower.includes('hybrid')
    ) {
      return 'Yes';
    }

    // Employment type
    if (labelLower.includes('employment type') || labelLower.includes('work type')) {
      return 'Full-time';
    }

    // Education
    if (
      labelLower.includes('degree') ||
      labelLower.includes('education level') ||
      labelLower.includes('highest education')
    ) {
      return 'B. Tech';
    }
    // "first-generation college student?" is a yes/no question that happens to
    // contain "college" — it was being answered with the university's name.
    if (labelLower.includes('first-generation') || labelLower.includes('first generation')) {
      return 'No';
    }
    if (
      labelLower.includes('university') ||
      labelLower.includes('school') ||
      labelLower.includes('college') ||
      labelLower.includes('institution')
    ) {
      return 'DIT University';
    }
    if (
      labelLower.includes('major') ||
      labelLower.includes('field of study') ||
      labelLower.includes('discipline')
    ) {
      return 'Computer Science';
    }
    if (labelLower.includes('graduation') || labelLower.includes('year of completion')) {
      return '2018';
    }

    // How did you hear
    if (
      labelLower.includes('how did you hear') ||
      labelLower.includes('where did you find') ||
      labelLower.includes('referral source') ||
      labelLower.includes('how did you learn')
    ) {
      return 'LinkedIn';
    }

    // ── Demographics ──
    // Order is load-bearing. These are substring tests, so the narrower question
    // has to be answered before the broader token it contains — "do you identify
    // as transgender?" contains "gender", and was being answered "Female".
    if (labelLower.includes('transgender')) return 'No';
    if (labelLower.includes('hispanic') || labelLower.includes('latino')) return 'No';
    if (labelLower.includes('gender') && labelLower.includes('identify')) return 'Woman';
    if (labelLower.includes('gender')) return 'Female';
    if (labelLower.includes('race') || labelLower.includes('ethnicity')) return 'Asian';
    if (labelLower.includes('veteran')) return 'No';
    if (labelLower.includes('disability') || labelLower.includes('handicap')) return 'No';
    if (labelLower.includes('lgbtq') || labelLower.includes('sexual orientation'))
      return 'Heterosexual';
    if (labelLower.includes('pronoun')) return 'She/Her';
    // Bare "I identify as:" — gender identity, distinct from the race/veteran/
    // disability questions that also use the phrase, hence the exclusions.
    if (
      labelLower.includes('identify as') &&
      !labelLower.includes('race') &&
      !labelLower.includes('ethnicity') &&
      !labelLower.includes('veteran') &&
      !labelLower.includes('disability') &&
      !labelLower.includes('orientation')
    ) {
      return 'Cisgender';
    }

    // ── Generic yes/no — only for dropdowns, not text inputs ──
    if (fieldType === 'text') return null;

    const yesPatterns = [
      'are you open to',
      'are you willing',
      'are you able',
      'are you comfortable',
      'are you available',
      'are you interested',
      'do you have the right',
      'do you have authorization',
      'can you commute',
      'can you work',
      'can you start',
      'will you be able',
      'would you be open',
      'do you agree',
      'acknowledge',
    ];
    if (yesPatterns.some((p) => labelLower.includes(p))) return 'Yes';

    const noPatterns = [
      'non-compete',
      'non compete',
      'previously applied',
      'applied before',
      'government employee',
      'government official',
    ];
    if (noPatterns.some((p) => labelLower.includes(p))) return 'No';

    return null;
  }
}
