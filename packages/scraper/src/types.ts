// These types live in @job-agent/shared, next to the Mongoose schemas that
// persist them. This file used to be a hand-copy and had drifted: it never
// gained the 'ashby' source, even though the scraper has been emitting Ashby
// jobs since sourcing/ashby.service.ts was added. That single missing string
// literal was behind seven type errors across the apply pipeline.
//
// Re-exported rather than deleted so the ~40 `from '../types'` imports keep
// working; there is nothing scraper-specific left to declare here.
export type { JobSource, JobStatus, JobListing, ScoredJob } from '@job-agent/shared';
