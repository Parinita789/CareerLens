// packages/scraper/src/sourcing/verify-slugs.ts
import { TARGET_COMPANIES } from '../common/company-directory';

async function verifySlugs() {
  console.log('Verifying all company slugs...\n');

  const results = { valid: [] as string[], invalid: [] as string[] };

  for (const company of TARGET_COMPANIES) {
    const url =
      company.ats === 'greenhouse'
        ? `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs`
        : `https://api.lever.co/v0/postings/${company.slug}?mode=json`;

    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) {
        const data = (await res.json()) as any;
        const count = company.ats === 'greenhouse' ? (data.jobs?.length ?? 0) : (data?.length ?? 0);
        console.log(`  ✓ ${company.name} (${company.ats}): ${count} jobs`);
        results.valid.push(company.name);
      } else {
        console.log(`  ✗ ${company.name} — ${res.status} (slug: ${company.slug})`);
        results.invalid.push(`${company.name} [${company.slug}]`);
      }
    } catch (err) {
      console.log(`  ✗ ${company.name} — network error`);
      results.invalid.push(company.name);
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n=== Results ===`);
  console.log(`Valid:   ${results.valid.length}`);
  console.log(`Invalid: ${results.invalid.length}`);
  console.log(`\nInvalid slugs to fix:`);
  results.invalid.forEach((n) => console.log(`  - ${n}`));
}

verifySlugs().catch(console.error);
