import { Module } from '@nestjs/common';
import { OptionMatcherService } from './option-matcher.service';
import { DirectAnswerService } from './direct-answer.service';
import { QuestionAnswererService } from './question-answerer.service';

@Module({
  providers: [OptionMatcherService, DirectAnswerService, QuestionAnswererService],
  exports: [OptionMatcherService, DirectAnswerService, QuestionAnswererService],
})
export class AnswerResolutionModule {}
