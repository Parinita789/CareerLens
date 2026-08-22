import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAdhocCoverLetterDto {
  @ApiProperty({ description: 'Full job description text pasted by the user (no scraped job required).' })
  description!: string;

  @ApiPropertyOptional({ example: 'Senior Backend Engineer' })
  title?: string;

  @ApiPropertyOptional({ example: 'Acme Corp' })
  company?: string;
}
