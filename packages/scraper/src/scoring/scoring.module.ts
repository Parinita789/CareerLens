import { Module } from '@nestjs/common';
import { DealBreakerService } from './deal-breakers.service';
import { LlmScorerService } from './llm-scorer.service';
import { QuickRejectService } from './quick-reject.service';

@Module({
  providers: [DealBreakerService, LlmScorerService, QuickRejectService],
  exports: [DealBreakerService, LlmScorerService, QuickRejectService],
})
export class ScoringModule {}
