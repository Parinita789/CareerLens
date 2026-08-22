export interface CompanyConfig {
  name: string;
  ats: 'greenhouse' | 'lever' | 'ashby';
  slug: string;
  domain: string;
}

// Only verified slugs — all return 200 from Greenhouse/Lever APIs.
export const TARGET_COMPANIES: CompanyConfig[] = [
  // ── Fintech ───────────────────────────────────────────────────────
  // { name: 'Stripe', ats: 'greenhouse', slug: 'stripe', domain: 'Fintech' },
  { name: 'Brex', ats: 'greenhouse', slug: 'brex', domain: 'Fintech' },
  { name: 'Chime', ats: 'greenhouse', slug: 'chime', domain: 'Fintech' },
  { name: 'Robinhood', ats: 'greenhouse', slug: 'robinhood', domain: 'Fintech' },
  { name: 'Coinbase', ats: 'greenhouse', slug: 'coinbase', domain: 'Fintech' },
  { name: 'Affirm', ats: 'greenhouse', slug: 'affirm', domain: 'Fintech' },
  { name: 'Marqeta', ats: 'greenhouse', slug: 'marqeta', domain: 'Fintech' },
  { name: 'Adyen', ats: 'greenhouse', slug: 'adyen', domain: 'Fintech' },
  { name: 'Nubank', ats: 'greenhouse', slug: 'nubank', domain: 'Fintech' },
  { name: 'Carta', ats: 'greenhouse', slug: 'carta', domain: 'Fintech' },
  { name: 'Gusto', ats: 'greenhouse', slug: 'gusto', domain: 'Fintech' },

  // ── Developer Tools ───────────────────────────────────────────────
  { name: 'Postman', ats: 'greenhouse', slug: 'postman', domain: 'Developer Tools' },
  { name: 'Grafana Labs', ats: 'greenhouse', slug: 'grafanalabs', domain: 'Developer Tools' },
  { name: 'PlanetScale', ats: 'greenhouse', slug: 'planetscale', domain: 'Developer Tools' },
  { name: 'Temporal', ats: 'greenhouse', slug: 'temporal', domain: 'Developer Tools' },
  { name: 'LaunchDarkly', ats: 'greenhouse', slug: 'launchdarkly', domain: 'Developer Tools' },
  { name: 'Amplitude', ats: 'greenhouse', slug: 'amplitude', domain: 'Developer Tools' },
  { name: 'Mixpanel', ats: 'greenhouse', slug: 'mixpanel', domain: 'Developer Tools' },
  { name: 'Contentful', ats: 'greenhouse', slug: 'contentful', domain: 'Developer Tools' },
  { name: 'CircleCI', ats: 'greenhouse', slug: 'circleci', domain: 'Developer Tools' },

  // ── SaaS ──────────────────────────────────────────────────────────
  { name: 'Figma', ats: 'greenhouse', slug: 'figma', domain: 'SaaS' },
  { name: 'Airtable', ats: 'greenhouse', slug: 'airtable', domain: 'SaaS' },
  { name: 'Asana', ats: 'greenhouse', slug: 'asana', domain: 'SaaS' },
  { name: 'Intercom', ats: 'greenhouse', slug: 'intercom', domain: 'SaaS' },
  { name: 'HubSpot', ats: 'greenhouse', slug: 'hubspot', domain: 'SaaS' },
  { name: 'Dropbox', ats: 'greenhouse', slug: 'dropbox', domain: 'SaaS' },
  { name: 'Calendly', ats: 'greenhouse', slug: 'calendly', domain: 'SaaS' },
  { name: 'Typeform', ats: 'greenhouse', slug: 'typeform', domain: 'SaaS' },
  { name: 'Webflow', ats: 'greenhouse', slug: 'webflow', domain: 'SaaS' },

  // ── Infrastructure ────────────────────────────────────────────────
  { name: 'Datadog', ats: 'greenhouse', slug: 'datadog', domain: 'Infrastructure' },
  { name: 'Cloudflare', ats: 'greenhouse', slug: 'cloudflare', domain: 'Infrastructure' },
  { name: 'PagerDuty', ats: 'greenhouse', slug: 'pagerduty', domain: 'Infrastructure' },
  { name: 'Fastly', ats: 'greenhouse', slug: 'fastly', domain: 'Infrastructure' },
  { name: 'Elastic', ats: 'greenhouse', slug: 'elastic', domain: 'Infrastructure' },
  { name: 'MongoDB', ats: 'greenhouse', slug: 'mongodb', domain: 'Infrastructure' },
  { name: 'Cockroach Labs', ats: 'greenhouse', slug: 'cockroachlabs', domain: 'Infrastructure' },
  { name: 'New Relic', ats: 'greenhouse', slug: 'newrelic', domain: 'Infrastructure' },
  { name: 'Netlify', ats: 'greenhouse', slug: 'netlify', domain: 'Infrastructure' },
  { name: 'Twilio', ats: 'greenhouse', slug: 'twilio', domain: 'Infrastructure' },

  // ── AI/ML ─────────────────────────────────────────────────────────
  { name: 'Anthropic', ats: 'greenhouse', slug: 'anthropic', domain: 'AI/ML' },
  { name: 'Scale AI', ats: 'greenhouse', slug: 'scaleai', domain: 'AI/ML' },
  { name: 'Runway', ats: 'greenhouse', slug: 'runwayml', domain: 'AI/ML' },
  { name: 'Contextual AI', ats: 'greenhouse', slug: 'contextualai', domain: 'AI/ML' },

  // ── E-commerce ────────────────────────────────────────────────────
  { name: 'Klaviyo', ats: 'greenhouse', slug: 'klaviyo', domain: 'E-commerce' },
  { name: 'Faire', ats: 'greenhouse', slug: 'faire', domain: 'E-commerce' },
  { name: 'Attentive', ats: 'greenhouse', slug: 'attentive', domain: 'E-commerce' },
  { name: 'Recharge', ats: 'greenhouse', slug: 'recharge', domain: 'E-commerce' },
  { name: 'Triple Whale', ats: 'greenhouse', slug: 'triplewhale', domain: 'E-commerce' },
  { name: 'Yotpo', ats: 'greenhouse', slug: 'yotpo', domain: 'E-commerce' },

  // ── Healthcare ────────────────────────────────────────────────────
  { name: 'Oscar Health', ats: 'greenhouse', slug: 'oscar', domain: 'Healthcare' },
  { name: 'Zocdoc', ats: 'greenhouse', slug: 'zocdoc', domain: 'Healthcare' },
  { name: 'Calm', ats: 'greenhouse', slug: 'calm', domain: 'Healthcare' },

  // ── Gaming ────────────────────────────────────────────────────────
  { name: 'Roblox', ats: 'greenhouse', slug: 'roblox', domain: 'Gaming' },
  { name: 'Discord', ats: 'greenhouse', slug: 'discord', domain: 'Gaming' },
  { name: 'Twitch', ats: 'greenhouse', slug: 'twitch', domain: 'Gaming' },
  { name: 'Epic Games', ats: 'greenhouse', slug: 'epicgames', domain: 'Gaming' },
  { name: 'Scopely', ats: 'greenhouse', slug: 'scopely', domain: 'Gaming' },

  // ── Cybersecurity ─────────────────────────────────────────────────
  { name: 'Okta', ats: 'greenhouse', slug: 'okta', domain: 'Cybersecurity' },
  { name: 'Orca Security', ats: 'greenhouse', slug: 'orcasecurity', domain: 'Cybersecurity' },

  // ── Data / Analytics ──────────────────────────────────────────────
  { name: 'Databricks', ats: 'greenhouse', slug: 'databricks', domain: 'Data' },
  { name: 'Fivetran', ats: 'greenhouse', slug: 'fivetran', domain: 'Data' },
  { name: 'Starburst', ats: 'greenhouse', slug: 'starburst', domain: 'Data' },

  // ── Ashby Companies (direct career page API — jobs appear before LinkedIn) ──
  { name: 'Ramp', ats: 'ashby', slug: 'ramp', domain: 'Fintech' },
  { name: 'Notion', ats: 'ashby', slug: 'notion', domain: 'SaaS' },
  { name: 'Plaid', ats: 'ashby', slug: 'plaid', domain: 'Fintech' },
  { name: 'Linear', ats: 'ashby', slug: 'linear', domain: 'Developer Tools' },
  { name: 'Vanta', ats: 'ashby', slug: 'vanta', domain: 'Security' },
  { name: 'Anyscale', ats: 'ashby', slug: 'anyscale', domain: 'AI/ML' },
  { name: 'Watershed', ats: 'ashby', slug: 'watershed', domain: 'Climate' },
  { name: 'Persona', ats: 'ashby', slug: 'persona', domain: 'Security' },
  { name: 'Stytch', ats: 'ashby', slug: 'stytch', domain: 'Security' },
  { name: 'Hightouch', ats: 'ashby', slug: 'hightouch', domain: 'Data' },
];
