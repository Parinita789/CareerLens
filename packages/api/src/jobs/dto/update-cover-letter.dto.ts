import { ApiProperty } from '@nestjs/swagger';

export class UpdateCoverLetterDto {
  @ApiProperty({ description: 'Full cover letter text to save as the current version for this job.' })
  content!: string;
}
