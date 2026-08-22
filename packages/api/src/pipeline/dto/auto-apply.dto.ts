import { ApiProperty } from '@nestjs/swagger';

export class AutoApplyDto {
  @ApiProperty({ description: 'Job externalIds to auto-apply to.', type: [String] })
  jobIds!: string[];
}
