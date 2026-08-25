/**
 * Identity for "the same role", used to dedup postings that share no id or URL —
 * the same job listed on two boards, or re-listed under a new posting id.
 *
 * Trimming matters: scraped titles and company names routinely carry stray
 * leading/trailing whitespace from the page markup, and an untrimmed key lets
 * "Sigma" and "Sigma " through as two distinct roles.
 */
export function roleKey(job: { company?: string | null; title?: string | null }): string {
  const company = String(job.company ?? '')
    .trim()
    .toLowerCase();
  const title = String(job.title ?? '')
    .trim()
    .toLowerCase();
  return `${company}|||${title}`;
}
