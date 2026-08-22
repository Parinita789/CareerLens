import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateSettingsDto {
  @ApiPropertyOptional({
    description: 'When false, the bot fills application forms but stops before clicking Submit. Read fresh on every pipeline spawn.',
    default: false,
  })
  allowAutoSubmit?: boolean;
}
