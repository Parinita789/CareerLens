import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateJobStatusDto {
  @ApiProperty({
    enum: ['to_apply', 'applied', 'rejected', 'no_response', 'interviewing', 'accepted', 'declined', 'draft'],
    example: 'applied',
  })
  status!: string;

  @ApiPropertyOptional({ description: 'Reason for the status change (e.g. a rejection note).' })
  reason?: string;

  @ApiPropertyOptional({
    description: 'Interview round label. Only persisted when status is "interviewing".',
    example: 'Onsite',
  })
  interview_round?: string;

  @ApiPropertyOptional({
    description: 'Outcome detail. Only persisted when status is "accepted".',
    example: 'Signed offer',
  })
  accepted_outcome?: string;
}
