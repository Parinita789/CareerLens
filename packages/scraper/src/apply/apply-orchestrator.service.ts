import { Inject, Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import { GreenhouseApplyService, type ApplicationResult as GreenhouseApplicationResult } from './greenhouse/greenhouse-apply.service';
import { EasyApplyService, type ApplicationResult as EasyApplyApplicationResult } from './easy-apply.service';
import { LinkedInProbeService } from '../sourcing/linkedin-probe.service';
import type { ScoredJob } from '../types';

export type ApplyResult = GreenhouseApplicationResult | EasyApplyApplicationResult;

@Injectable()
export class ApplyOrchestratorService {
  constructor(
    @Inject(GreenhouseApplyService) private readonly greenhouseApply: GreenhouseApplyService,
    @Inject(EasyApplyService) private readonly easyApply: EasyApplyService,
    @Inject(LinkedInProbeService) private readonly linkedInProbe: LinkedInProbeService,
  ) {}

  async applyToJob(page: Page, job: ScoredJob, submit: boolean): Promise<ApplyResult> {
    if (job.source === 'greenhouse' || job.source === 'ashby') {
      return this.greenhouseApply.apply(page, job, submit);
    }

    if (job.source === 'linkedin') {
      // Probe whether this LinkedIn job is Easy Apply or redirects to an
      // external ATS. If the redirect is to Greenhouse/Ashby, reroute through
      // the Greenhouse applier — it handles those DOMs much better than
      // EasyApplyService, which can only drive LinkedIn's own modal.
      const probe = await this.linkedInProbe.probeLinkedInApplyTarget(page, job.url);
      if (probe.kind === 'easy_apply') {
        console.log('  Detected: LinkedIn Easy Apply → using Easy Apply flow');
        return this.easyApply.applyViaEasyApply(page, job, submit);
      }
      if (probe.kind === 'external') {
        const ats = this.linkedInProbe.classifyAts(probe.url);
        console.log(`  Detected: external ATS "${probe.host}" (classified as ${ats})`);
        if (ats === 'greenhouse' || ats === 'ashby') {
          // Hand the external URL to the Greenhouse applier by passing a
          // modified job object (original LinkedIn URL left alone in DB).
          return this.greenhouseApply.apply(page, { ...job, url: probe.url, source: ats }, submit);
        }
        console.log(`  Unsupported external ATS (${probe.host}) — skipping`);
        return { success: false, reason: `Unsupported external ATS: ${probe.host}` };
      }
      console.log(`  Probe inconclusive (${probe.reason}) — trying Easy Apply as fallback`);
      return this.easyApply.applyViaEasyApply(page, job, submit);
    }

    return this.easyApply.applyViaEasyApply(page, job, submit);
  }
}
