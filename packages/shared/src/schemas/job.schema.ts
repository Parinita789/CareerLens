import mongoose from 'mongoose';

const jobSchema = new mongoose.Schema(
  {
    externalId:        { type: String, unique: true, required: true },
    title:             { type: String, required: true },
    company:           { type: String, required: true },
    location:          String,
    remote:            Boolean,
    employment_type:   String,
    salary_min:        Number,
    salary_max:        Number,
    description:       String,
    url:               String,
    source:            { type: String, enum: ['linkedin', 'greenhouse', 'lever', 'indeed', 'ashby', 'manual'] },
    scraped_at:        Date,
    posted_at:         Date,
    fit_score:         Number,
    apply:             Boolean,
    matched_skills:    [String],
    missing_skills:    [String],
    reason:            String,
    deal_breaker:      String,
    status: {
      type: String,
      enum: ['to_apply', 'applied', 'rejected', 'no_response', 'interviewing', 'accepted', 'declined'],
      default: 'to_apply',
    },
    applied_at:        { type: Date, default: null },
    applied_via:       { type: String, enum: ['auto', 'manual'], default: null },
    interview_round:   { type: String, default: null },
    accepted_outcome:  { type: String, default: null },
    notes:             { type: String, default: '' },
  },
  { timestamps: true }
);

jobSchema.index({ company: 1, title: 1 });
jobSchema.index({ status: 1 });
jobSchema.index({ url: 1 });

export const JobModel = mongoose.model('Job', jobSchema);
