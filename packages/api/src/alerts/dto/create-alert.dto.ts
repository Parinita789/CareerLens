import { ApiProperty } from '@nestjs/swagger';

export class CreateAlertDto {
  @ApiProperty({ description: 'Search keywords, e.g. LinkedIn job-search query.', example: 'Senior Backend Engineer' })
  keywords!: string;

  @ApiProperty({ example: 'United States' })
  location!: string;
}
