import { ApiProperty } from '@nestjs/swagger';

export class UpdateApplicationFieldsStatusDto {
  @ApiProperty({ enum: ['ready', 'needs_review', 'pending', 'applied'], example: 'ready' })
  status!: string;
}
