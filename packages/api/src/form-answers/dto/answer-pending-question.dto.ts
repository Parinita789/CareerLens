import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AnswerPendingQuestionDto {
  @ApiProperty({ description: 'The user\'s answer. Use "__SKIP__" to skip the question.' })
  answer!: string;

  @ApiPropertyOptional({
    description: 'Save this answer as a reusable rule for future applications. Defaults to true.',
    default: true,
  })
  saveAsRule?: boolean;
}
