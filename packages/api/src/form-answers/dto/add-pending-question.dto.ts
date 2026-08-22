import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AddPendingQuestionDto {
  @ApiProperty({ example: 'Senior Backend Engineer' })
  jobTitle!: string;

  @ApiProperty({ example: 'Acme Corp' })
  company!: string;

  @ApiProperty({ description: 'The application-form question text.' })
  question!: string;

  @ApiProperty({ enum: ['text', 'textarea', 'select', 'radio'] })
  type!: string;

  @ApiPropertyOptional({ description: 'Choices, for select/radio questions.', type: [String] })
  options?: string[];
}
