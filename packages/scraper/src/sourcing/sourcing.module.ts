import { Module } from '@nestjs/common';
import { AshbyService } from './ashby.service';
import { GreenhouseService } from './greenhouse.service';
import { LeverService } from './lever.service';
import { IndeedService } from './indeed.service';
import { LinkedInService } from './linkedin.service';
import { LinkedInAlertsService } from './linkedin-alerts.service';
import { LinkedInProbeService } from './linkedin-probe.service';
import { GmailAlertsService } from './gmail-alerts.service';
import { FormScraperService } from './form-scraper.service';

@Module({
  providers: [
    AshbyService,
    GreenhouseService,
    LeverService,
    IndeedService,
    LinkedInService,
    LinkedInAlertsService,
    LinkedInProbeService,
    GmailAlertsService,
    FormScraperService,
  ],
  exports: [
    AshbyService,
    GreenhouseService,
    LeverService,
    IndeedService,
    LinkedInService,
    LinkedInAlertsService,
    LinkedInProbeService,
    GmailAlertsService,
    FormScraperService,
  ],
})
export class SourcingModule {}
