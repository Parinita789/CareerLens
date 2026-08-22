import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateFieldDto {
  @ApiProperty({ description: 'New value for this form field.' })
  value!: string;

  @ApiPropertyOptional({
    description: 'Save this value as a reusable answer rule for future applications. Defaults to true.',
    default: true,
  })
  saveAsRule?: boolean;
}
