import { scrapeLinkedIn } from './linkedin';
import type { JobListing } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALERTS_FILE = path.join(__dirname, '../../data/alerts.json');
const JOBS_PER_ALERT = 25;

interface Alert {
  id: string;
  keywords: string;
  location: string;
  label: string;
}

function loadAlerts(): Alert[] {
  if (!fs.existsSync(ALERTS_FILE)) return [];
  const content = fs.readFileSync(ALERTS_FILE, 'utf-8').trim();
  if (!content) return [];
  return JSON.parse(content);
}

export async function scrapeLinkedInAlerts(
  maxJobsPerAlert: number = JOBS_PER_ALERT,
): Promise<JobListing[]> {
  const alerts = loadAlerts();

  if (alerts.length === 0) {
    console.log('  No alerts configured. Add keywords via the UI or in data/alerts.json');
    return [];
  }

  console.log(`  ${alerts.length} alert keyword(s) configured`);
  const allJobs: JobListing[] = [];

  for (const alert of alerts) {
    console.log(`\n  Alert: "${alert.label}" (${alert.keywords} in ${alert.location})`);
    try {
      const jobs = await scrapeLinkedIn(alert.keywords, alert.location, maxJobsPerAlert);
      console.log(`  Got ${jobs.length} jobs from "${alert.label}"`);
      allJobs.push(...jobs);
    } catch (err) {
      console.error(`  Alert "${alert.label}" failed: ${(err as Error).message}`);
    }
  }

  console.log(`\n  Alert scraping complete: ${allJobs.length} total jobs`);
  return allJobs;
}
