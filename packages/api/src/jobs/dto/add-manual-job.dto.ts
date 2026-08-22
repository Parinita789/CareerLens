import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AddManualJobDto {
  @ApiProperty({ example: 'Senior Backend Engineer' })
  title!: string;

  @ApiProperty({ example: 'Acme Corp' })
  company!: string;

  @ApiPropertyOptional({ description: 'Job posting URL.' })
  url?: string;

  @ApiPropertyOptional({
    description: 'Source platform. Defaults to "linkedin" if omitted.',
    example: 'linkedin',
  })
  source?: string;

  @ApiPropertyOptional({
    description: 'Tracked status. Defaults to "applied" if omitted or not one of the allowed values.',
    enum: ['applied', 'interviewing', 'accepted', 'declined'],
  })
  status?: string;

  @ApiPropertyOptional({ description: 'Only used when status is "interviewing".' })
  interview_round?: string;

  @ApiPropertyOptional({ description: 'Only used when status is "accepted".' })
  accepted_outcome?: string;
}
