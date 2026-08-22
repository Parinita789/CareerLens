import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RunPhasesDto {
  @ApiProperty({
    description: 'Phase IDs to run, in order.',
    example: ['scrape', 'apply'],
    enum: ['scrape', 'gmail-alerts', 'apply'],
    isArray: true,
  })
  phases!: string[];

  @ApiPropertyOptional({
    description: 'Job sources to scrape. Only used when the "scrape" phase is included.',
    example: ['linkedin', 'greenhouse'],
  })
  scrapeSources?: string[];

  @ApiPropertyOptional({
    description: 'ATS platforms to auto-apply through. Only used when the "apply" phase is included.',
    example: ['greenhouse', 'linkedin'],
  })
  applyPlatforms?: string[];

  @ApiPropertyOptional({ description: 'Cap on how many jobs to auto-apply to in this run.' })
  applyLimit?: number;

  @ApiPropertyOptional({
    description: 'Specific job externalIds to auto-apply to, instead of the default eligibility filter.',
  })
  applyJobIds?: string[];
}
