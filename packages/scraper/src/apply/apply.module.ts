import { Module } from '@nestjs/common';
import { AnswerResolutionModule } from '../answer-resolution/answer-resolution.module';
import { SourcingModule } from '../sourcing/sourcing.module';
import { FormHandlerService } from './form-handler.service';
import { EasyApplyService } from './easy-apply.service';
import { ApplyOrchestratorService } from './apply-orchestrator.service';
import { GreenhouseFieldInspectorService } from './greenhouse/greenhouse-field-inspector.service';
import { GreenhouseFormCaptureService } from './greenhouse/greenhouse-form-capture.service';
import { GreenhouseSubmissionWatcherService } from './greenhouse/greenhouse-submission-watcher.service';
import { GreenhouseUrlResolverService } from './greenhouse/greenhouse-url-resolver.service';
import { GreenhouseAttachmentService } from './greenhouse/greenhouse-attachment.service';
import { AshbyFormFillerService } from './greenhouse/ashby-form-filler.service';
import { GreenhouseFormFillerService } from './greenhouse/greenhouse-form-filler.service';
import { GreenhouseApplyService } from './greenhouse/greenhouse-apply.service';

@Module({
  imports: [AnswerResolutionModule, SourcingModule],
  providers: [
    FormHandlerService,
    EasyApplyService,
    ApplyOrchestratorService,
    GreenhouseFieldInspectorService,
    GreenhouseFormCaptureService,
    GreenhouseSubmissionWatcherService,
    GreenhouseUrlResolverService,
    GreenhouseAttachmentService,
    AshbyFormFillerService,
    GreenhouseFormFillerService,
    GreenhouseApplyService,
  ],
  exports: [ApplyOrchestratorService, EasyApplyService, GreenhouseApplyService, FormHandlerService],
})
export class ApplyModule {}
