import { ApiPropertyOptional } from '@nestjs/swagger';

export class ProfileMetaDto {
  @ApiPropertyOptional() version?: string;
  @ApiPropertyOptional() last_updated?: string;
  @ApiPropertyOptional() agent?: string;
}

export class ProfilePersonalDto {
  @ApiPropertyOptional() name?: string;
  @ApiPropertyOptional() email?: string;
  @ApiPropertyOptional() phone?: string;
  @ApiPropertyOptional() location?: string;
  @ApiPropertyOptional() linkedin?: string;
  @ApiPropertyOptional() github?: string;
}

export class ProfileExperienceDto {
  @ApiPropertyOptional() total_years?: number;
  @ApiPropertyOptional() current_level?: string;
  @ApiPropertyOptional() summary?: string;
}

export class ProfileSkillsDto {
  @ApiPropertyOptional({ type: [String] }) languages?: string[];
  @ApiPropertyOptional({ type: [String] }) frameworks?: string[];
  @ApiPropertyOptional({ type: [String] }) databases?: string[];
  @ApiPropertyOptional({ type: [String] }) messaging?: string[];
  @ApiPropertyOptional({ type: [String] }) cloud?: string[];
  @ApiPropertyOptional({ type: [String] }) devops?: string[];
  @ApiPropertyOptional({ type: [String] }) architecture?: string[];
  @ApiPropertyOptional({ type: [String] }) ai?: string[];
  @ApiPropertyOptional({ type: [String] }) tools?: string[];
  @ApiPropertyOptional({ type: [String] }) methodologies?: string[];
}

export class ProfileAchievementDto {
  @ApiPropertyOptional() company?: string;
  @ApiPropertyOptional() impact?: string;
}

export class ProfileWorkHistoryDto {
  @ApiPropertyOptional() company?: string;
  @ApiPropertyOptional() location?: string;
  @ApiPropertyOptional() title?: string;
  @ApiPropertyOptional() start?: string;
  @ApiPropertyOptional() end?: string;
  @ApiPropertyOptional() duration_years?: number;
}

export class ProfileLocationPreferenceDto {
  @ApiPropertyOptional() current_city?: string;
  @ApiPropertyOptional() remote?: boolean;
  @ApiPropertyOptional() hybrid_us?: boolean;
  @ApiPropertyOptional() onsite?: boolean;
  @ApiPropertyOptional() international_remote?: boolean;
}

export class ProfilePreferencesDto {
  @ApiPropertyOptional({ type: [String] }) target_roles?: string[];
  @ApiPropertyOptional({ type: ProfileLocationPreferenceDto }) location?: ProfileLocationPreferenceDto;
  @ApiPropertyOptional({ type: [String] }) employment_type?: string[];
  @ApiPropertyOptional() visa_sponsorship_required?: boolean;
  @ApiPropertyOptional({ description: 'Free-form — e.g. a range, or a list of preferred sizes.' }) company_size?: unknown;
  @ApiPropertyOptional({ type: [String] }) excluded_industries?: string[];
  @ApiPropertyOptional({ type: [String] }) preferred_domains?: string[];
}

export class ProfileCompensationDto {
  @ApiPropertyOptional() currency?: string;
  @ApiPropertyOptional() base_salary_min?: number;
  @ApiPropertyOptional() base_salary_preferred?: number;
  @ApiPropertyOptional() equity?: string;
  @ApiPropertyOptional() notes?: string;
}

export class ProfileStrengthsForAgentDto {
  @ApiPropertyOptional({ type: [String] }) use_for_cover_letter?: string[];
  @ApiPropertyOptional({ type: [String] }) ats_keywords?: string[];
}

// Source of truth for EEO / self-identification questions — injected into every LLM
// answer prompt so paraphrased demographic questions resolve deterministically.
export class ProfileDemographicsDto {
  @ApiPropertyOptional({ description: '"" means decline to answer.', example: 'Asian' }) race?: string;
  @ApiPropertyOptional() hispanic_or_latino?: boolean;
  @ApiPropertyOptional({ example: 'Female' }) gender?: string;
  @ApiPropertyOptional({ example: 'She/Her' }) pronouns?: string;
  @ApiPropertyOptional() disability?: boolean;
  @ApiPropertyOptional() veteran?: boolean;
  @ApiPropertyOptional() transgender?: boolean;
  @ApiPropertyOptional({ example: 'Heterosexual' }) sexual_orientation?: string;
  @ApiPropertyOptional() citizen_or_permanent_resident?: boolean;
}

export class ProfileSettingsDto {
  @ApiPropertyOptional({
    description: 'When false, the bot fills application forms but stops before clicking Submit.',
    default: false,
  })
  allowAutoSubmit?: boolean;
}

export class ProfileDto {
  @ApiPropertyOptional({ type: ProfileMetaDto }) meta?: ProfileMetaDto;
  @ApiPropertyOptional({ type: ProfilePersonalDto }) personal?: ProfilePersonalDto;
  @ApiPropertyOptional({ type: ProfileExperienceDto }) experience?: ProfileExperienceDto;
  @ApiPropertyOptional({ type: ProfileSkillsDto }) skills?: ProfileSkillsDto;
  @ApiPropertyOptional({ type: [ProfileAchievementDto] }) top_achievements?: ProfileAchievementDto[];
  @ApiPropertyOptional({ type: [ProfileWorkHistoryDto] }) work_history?: ProfileWorkHistoryDto[];
  @ApiPropertyOptional({ type: ProfilePreferencesDto }) preferences?: ProfilePreferencesDto;
  @ApiPropertyOptional({ type: ProfileCompensationDto }) compensation?: ProfileCompensationDto;
  @ApiPropertyOptional({ type: [String] }) deal_breakers?: string[];
  @ApiPropertyOptional({ type: ProfileStrengthsForAgentDto }) strengths_for_agent?: ProfileStrengthsForAgentDto;
  @ApiPropertyOptional({ type: ProfileDemographicsDto }) demographics?: ProfileDemographicsDto;
  @ApiPropertyOptional({ type: ProfileSettingsDto }) settings?: ProfileSettingsDto;
}
