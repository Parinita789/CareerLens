import { Module } from '@nestjs/common';
import { OptionMatcherService } from './option-matcher.service';
import { DirectAnswerService } from './direct-answer.service';
import { QuestionAnswererService } from './question-answerer.service';
import { FieldAnswerResolverService } from './field-answer-resolver.service';

@Module({
  providers: [OptionMatcherService, DirectAnswerService, QuestionAnswererService, FieldAnswerResolverService],
  exports: [OptionMatcherService, DirectAnswerService, QuestionAnswererService, FieldAnswerResolverService],
})
export class AnswerResolutionModule {}
