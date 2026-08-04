import mongoose from 'mongoose';

const coverLetterSchema = new mongoose.Schema(
  {
    jobId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    externalJobId: { type: String, required: true, index: true },
    content:     { type: String, required: true },
    rawContent:  { type: String },
    // Full history of every state `content` has ever been set to — both fresh
    // generations and manual edits. The UI only shows the latest, but the
    // 'edited' entries are what future generations learn voice from.
    versions: [
      {
        content: { type: String, required: true },
        source: { type: String, enum: ['generated', 'edited'], required: true },
        savedAt: { type: Date, default: Date.now },
      },
    ],
    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const CoverLetterModel = mongoose.model('CoverLetter', coverLetterSchema);
