import { Module } from '@nestjs/common';
import { ScoringModule } from './scoring/scoring.module';
import { PersistenceModule } from './persistence/persistence.module';
import { SourcingModule } from './sourcing/sourcing.module';
import { AnswerResolutionModule } from './answer-resolution/answer-resolution.module';
import { ApplyModule } from './apply/apply.module';

@Module({
  imports: [ScoringModule, PersistenceModule, SourcingModule, AnswerResolutionModule, ApplyModule],
})
export class AppModule {}
