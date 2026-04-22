import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    meta: {
      version: String,
      last_updated: String,
      agent: String,
    },
    personal: {
      name: String,
      email: String,
      phone: String,
      location: String,
      linkedin: String,
      github: String,
    },
    experience: {
      total_years: Number,
      current_level: String,
      summary: String,
    },
    skills: {
      languages: [String],
      frameworks: [String],
      databases: [String],
      messaging: [String],
      cloud: [String],
      devops: [String],
      architecture: [String],
      ai: [String],
      tools: [String],
      methodologies: [String],
    },
    top_achievements: [{ company: String, impact: String }],
    work_history: [{
      company: String,
      location: String,
      title: String,
      start: String,
      end: String,
      duration_years: Number,
    }],
    preferences: {
      target_roles: [String],
      location: {
        current_city: String,
        remote: Boolean,
        hybrid_us: Boolean,
        onsite: Boolean,
        international_remote: Boolean,
      },
      employment_type: [String],
      visa_sponsorship_required: Boolean,
      company_size: mongoose.Schema.Types.Mixed,
      excluded_industries: [String],
      preferred_domains: [String],
    },
    compensation: {
      currency: String,
      base_salary_min: Number,
      base_salary_preferred: Number,
      equity: String,
      notes: String,
    },
    deal_breakers: [String],
    strengths_for_agent: {
      use_for_cover_letter: [String],
      ats_keywords: [String],
    },
    // Demographics — source of truth for EEO / self-identification questions.
    // Injected into every LLM answer prompt so paraphrased questions resolve
    // deterministically without needing per-phrasing keyword rules.
    demographics: {
      race: String,                 // e.g. "Asian", "White", "Black or African American", "" = decline
      hispanic_or_latino: Boolean,
      gender: String,               // "Male" | "Female" | "Non-binary" | "" = decline
      pronouns: String,             // "She/Her" | "He/Him" | "They/Them" | ""
      disability: Boolean,
      veteran: Boolean,
      transgender: Boolean,
      sexual_orientation: String,   // "Heterosexual" | "Gay or Lesbian" | "" = decline
      citizen_or_permanent_resident: Boolean,
    },
  },
  { timestamps: true }
);

export const UserModel = mongoose.model('User', userSchema);
