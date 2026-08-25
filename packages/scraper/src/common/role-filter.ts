/**
 * Cheap pre-filter applied by the API-based scrapers (Ashby, Greenhouse, Lever)
 * before a posting is worth storing or scoring.
 *
 * Single source of truth on purpose: this used to be copy-pasted into all three
 * scrapers and had already drifted — Ashby's copy was missing seven tech
 * signals (fastify, next.js, pubsub, latency, throughput, high-traffic, high
 * traffic), so it silently rejected roles the other two accepted.
 *
 * Deliberately does NOT filter on location. It previously required the location
 * string to match a 13-city US whitelist, which dropped real US postings
 * wherever the city wasn't listed — Bellevue, Menlo Park, Charlotte, D.C. and a
 * bare "USA" were all being discarded. Location is now judged downstream by
 * DealBreakerService, which rejects on an explicit non-US list; that way a
 * location we don't recognise surfaces as a scored job rather than vanishing
 * silently at scrape time.
 */
export function isRelevantRole(title: string, description: string): boolean {
  const t = title.toLowerCase();
  const d = description.toLowerCase();

  // ── Hard excludes on title — instant reject ───────────────────────
  const titleExcludes = [
    'frontend',
    'front-end',
    'ios ',
    'android',
    'data scientist',
    'machine learning engineer',
    'designer',
    'ux ',
    'product manager',
    ' pm ',
    'sales ',
    'recruiter',
    'marketing',
    'finance',
    'legal',
    'test engineer',
    'sdet',
    'qa engineer',
    'devrel',
    'developer advocate',
    'embedded',
    'firmware',
    'hardware',
    'data analyst',
    'analytics engineer',
    'junior',
    'intern ',
    'graduate new',
    'php developer',
    'ruby developer',
    '.net developer',
    'java developer',
    'android developer',
  ];
  if (titleExcludes.some((k) => t.includes(k))) return false;

  // ── Must be a software/backend/platform role ──────────────────────
  const roleTitles = [
    'software engineer',
    'software developer',
    'backend engineer',
    'back-end engineer',
    'platform engineer',
    'fullstack',
    'full stack',
    'senior engineer',
    'senior developer',
    'engineer ii',
    'engineer iii',
    'engineer iv',
    'api engineer',
    'infrastructure engineer',
    'engineer,',
    'engineer -',
  ];
  if (!roleTitles.some((k) => t.includes(k))) return false;

  // ── Tech check — title OR description (much more permissive) ──────
  const techSignals = [
    'node',
    'typescript',
    'javascript',
    'golang',
    ' go ',
    'nestjs',
    'express',
    'fastify',
    'next.js',
    'microservice',
    'distributed',
    'event-driven',
    'api',
    'rest',
    'graphql',
    'aws',
    'gcp',
    'azure',
    'cloud',
    'docker',
    'kubernetes',
    'k8s',
    'mongodb',
    'postgresql',
    'postgres',
    'redis',
    'kafka',
    'rabbitmq',
    'pubsub',
    'backend',
    'back-end',
    'server-side',
    'scalab',
    'high-traffic',
    'high traffic',
    'latency',
    'throughput',
    'distributed system',
  ];

  // Title is a strong signal on its own; description needs 2+ matches.
  const titleHasTech = techSignals.some((k) => t.includes(k));
  const descHasTech = techSignals.filter((k) => d.includes(k)).length >= 2;

  return titleHasTech || descHasTech;
}
