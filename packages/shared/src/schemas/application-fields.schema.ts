import mongoose from 'mongoose';

const fieldSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    type: {
      type: String,
      enum: ['text', 'textarea', 'select', 'radio', 'file', 'combobox'],
      required: true,
    },
    value: { type: String, default: '' },
    source: { type: String, enum: ['profile', 'rule', 'llm', 'unknown'], default: 'unknown' },
    options: [String],
    fieldId: String,
    required: { type: Boolean, default: false },
  },
  { _id: false },
);

const applicationFieldsSchema = new mongoose.Schema(
  {
    externalJobId: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    company: { type: String, required: true },
    source: {
      type: String,
      enum: ['linkedin', 'greenhouse', 'lever', 'indeed', 'ashby', 'manual'],
    },
    url: String,
    status: {
      type: String,
      enum: ['ready', 'needs_review', 'pending', 'applied'],
      default: 'pending',
    },
    fields: [fieldSchema],
    unknownCount: { type: Number, default: 0 },
    coverLetter: String,
    scrapedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export const ApplicationFieldsModel = mongoose.model('ApplicationFields', applicationFieldsSchema);
