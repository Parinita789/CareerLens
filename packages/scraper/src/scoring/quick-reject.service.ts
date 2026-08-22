import { Injectable } from '@nestjs/common';
import type { JobListing } from '../types';

@Injectable()
export class QuickRejectService {
  quickReject(job: JobListing): string | null {
    const t = job.title.toLowerCase();
    const d = job.description.slice(0, 500).toLowerCase();

    // wrong role entirely
    const titleRejects = [
      'frontend',
      'front-end',
      'ios developer',
      'android developer',
      'data scientist',
      'machine learning engineer',
      'ml engineer',
      'designer',
      'ux ',
      'product manager',
      'sales ',
      'recruiter',
      'marketing',
      'finance',
      'legal',
      'devrel',
      'developer advocate',
      'embedded',
      'firmware',
      'hardware',
      'mechanical',
      'data analyst',
      'analytics engineer',
      'qa engineer',
      'sdet',
      'test engineer',
      'intern ',
      'junior',
      'principal',
      'staff ',
    ];
    for (const k of titleRejects) {
      if (t.includes(k)) return `Title exclude: ${k}`;
    }

    // wrong primary stack — description dominated by non-matching tech
    const wrongStack = [
      { keywords: ['java ', 'spring boot', 'jvm', 'kotlin'], label: 'Java/JVM' },
      { keywords: ['.net', 'c# ', 'asp.net', 'blazor'], label: '.NET/C#' },
      { keywords: ['ruby on rails', 'rails ', 'ruby '], label: 'Ruby/Rails' },
      { keywords: ['php ', 'laravel', 'symfony'], label: 'PHP' },
      { keywords: ['swift ', 'swiftui', 'uikit'], label: 'iOS/Swift' },
      { keywords: ['flutter', 'dart '], label: 'Flutter/Dart' },
    ];

    for (const stack of wrongStack) {
      const hits = stack.keywords.filter((k) => d.includes(k)).length;
      if (hits >= 2) return `Wrong stack: ${stack.label}`;
    }

    return null;
  }
}
