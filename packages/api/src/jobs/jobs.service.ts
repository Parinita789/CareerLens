import { Injectable, NotFoundException } from '@nestjs/common';
import { JobModel, CoverLetterModel, generateCoverLetter as generateCoverLetterShared } from '@job-agent/shared';

@Injectable()
export class JobsService {
  async getAllJobs(): Promise<any[]> {
    const jobs = await JobModel.find().sort({ fit_score: -1 }).lean();
    return jobs.map((j: any) => {
      const { _id, __v, ...rest } = j;
      return { ...rest, id: j.externalId };
    });
  }

  async getJobById(id: string): Promise<any> {
    const job = await JobModel.findOne({ externalId: id }).lean();
    if (!job) throw new NotFoundException(`Job ${id} not found`);

    // Attach latest cover letter if exists
    const coverLetter = await CoverLetterModel.findOne({ externalJobId: id }).sort({ generatedAt: -1 }).lean();
    if (coverLetter) {
      (job as any).cover_letter = coverLetter.content;
      if ((coverLetter as any).rawContent) {
        (job as any).cover_letter_raw = (coverLetter as any).rawContent;
      }
    }

    const { _id, __v, ...rest } = job as any;
    return { ...rest, id: (job as any).externalId };
  }

  async updateJobStatus(
    id: string,
    status: string,
    reason?: string,
    interviewRound?: string,
    acceptedOutcome?: string,
  ): Promise<any> {
    const update: any = { status };
    if (reason) update.reason = reason;
    if (status === 'applied') {
      update.applied_at = new Date();
      update.applied_via = 'manual';
    }
    // Setting interview_round only makes sense when the job is actively in
    // interviewing state. Leaving status alone keeps the existing round.
    if (status === 'interviewing' && interviewRound !== undefined) {
      update.interview_round = interviewRound;
    }
    // Moving out of interviewing — clear the round so it doesn't linger on
    // accepted/declined/rejected jobs.
    if (status !== 'interviewing' && status !== 'applied') {
      update.interview_round = null;
    }
    // Same shape as interview_round: only persist when in accepted state, and
    // wipe it on transitions away so stale outcomes don't follow the job.
    if (status === 'accepted' && acceptedOutcome !== undefined) {
      update.accepted_outcome = acceptedOutcome;
    }
    if (status !== 'accepted') {
      update.accepted_outcome = null;
    }

    const job = await JobModel.findOneAndUpdate(
      { externalId: id },
      { $set: update },
      { new: true },
    ).lean();

    if (!job) throw new NotFoundException(`Job ${id} not found`);

    // Sync applicationFields — remove from Prepare tab when job status changes
    if (['applied', 'declined', 'rejected'].includes(status)) {
      const { ApplicationFieldsModel } = await import('@job-agent/shared');
      await ApplicationFieldsModel.deleteOne({ externalJobId: id }).catch(() => {});
    }

    const { _id, __v, ...rest } = job as any;
    return { ...rest, id: (job as any).externalId };
  }

  async getJobsWithCoverLetters(): Promise<any[]> {
    const coverLetters = await CoverLetterModel.find().sort({ generatedAt: -1 }).lean();

    // Group by externalJobId, keep latest
    const latestByJob = new Map<string, any>();
    for (const cl of coverLetters) {
      if (!latestByJob.has(cl.externalJobId)) {
        latestByJob.set(cl.externalJobId, cl);
      }
    }

    const jobIds = Array.from(latestByJob.keys());
    const jobs = await JobModel.find({ externalId: { $in: jobIds } }).lean();

    return jobs
      .map((j) => {
        const cl = latestByJob.get(j.externalId);
        return {
          id: j.externalId,
          title: j.title,
          company: j.company,
          matched_skills: j.matched_skills || [],
          fit_score: j.fit_score,
          source: j.source,
          cover_letter: cl?.content || '',
          generated_at: cl?.generatedAt,
          is_adhoc: j.status === 'draft',
        };
      })
      .sort((a, b) => new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime());
  }

  async generateCoverLetter(id: string): Promise<{ cover_letter: string; cover_letter_raw: string }> {
    if (!/^[a-zA-Z0-9_\-]+$/.test(id)) {
      throw new Error('Invalid job ID format');
    }

    const job = await JobModel.findOne({ externalId: id }).lean();
    if (!job) throw new NotFoundException(`Job ${id} not found`);

    const { raw, final } = await generateCoverLetterShared(job as any);

    await CoverLetterModel.findOneAndUpdate(
      { externalJobId: id },
      { $set: { jobId: (job as any)._id, content: final, rawContent: raw, generatedAt: new Date() } },
      { upsert: true },
    );

    return { cover_letter: final, cover_letter_raw: raw };
  }

  async updateCoverLetter(id: string, content: string): Promise<{ cover_letter: string }> {
    if (!content || !content.trim()) {
      throw new Error('Cover letter content cannot be empty');
    }

    const coverLetter = await CoverLetterModel.findOneAndUpdate(
      { externalJobId: id },
      {
        $set: { content },
        $push: { versions: { content, source: 'edited', savedAt: new Date() } },
      },
      { new: true },
    ).lean();

    if (!coverLetter) throw new NotFoundException(`Cover letter for job ${id} not found`);

    return { cover_letter: (coverLetter as any).content };
  }

  async createAdhocCoverLetter(data: {
    description: string;
    title?: string;
    company?: string;
  }): Promise<{ id: string; cover_letter: string; cover_letter_raw: string }> {
    if (!data.description || !data.description.trim()) {
      throw new Error('Job description is required');
    }

    const id = `adhoc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = await JobModel.create({
      externalId: id,
      title: data.title || 'Untitled role',
      company: data.company || 'Unknown company',
      url: '',
      description: data.description,
      source: 'manual',
      location: '',
      fit_score: 0,
      apply: false,
      matched_skills: [],
      missing_skills: [],
      reason: '',
      status: 'draft',
      scraped_at: new Date(),
    });

    const { raw, final } = await generateCoverLetterShared(job.toObject() as any);

    await CoverLetterModel.create({
      jobId: job._id,
      externalJobId: id,
      content: final,
      rawContent: raw,
      versions: [{ content: final, source: 'generated' }],
      generatedAt: new Date(),
    });

    return { id, cover_letter: final, cover_letter_raw: raw };
  }

  async addManualJob(data: {
    title: string;
    company: string;
    url?: string;
    source?: string;
    status?: string;
    interview_round?: string;
    accepted_outcome?: string;
  }): Promise<any> {
    const id = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const allowed = ['applied', 'interviewing', 'accepted', 'declined'];
    const status = allowed.includes(data.status ?? '') ? (data.status as string) : 'applied';
    // applied_at is the day the user tracked the role; useful for accepted/
    // interviewing entries too so they sort correctly on those tabs.
    const job = await JobModel.create({
      externalId: id,
      title: data.title,
      company: data.company,
      url: data.url || '',
      description: '',
      source: data.source || 'linkedin',
      location: '',
      fit_score: 7,
      apply: true,
      matched_skills: [],
      missing_skills: [],
      reason: 'Manually added',
      status,
      applied_at: new Date(),
      applied_via: 'manual',
      interview_round: status === 'interviewing' ? data.interview_round || null : null,
      accepted_outcome: status === 'accepted' ? data.accepted_outcome || null : null,
      scraped_at: new Date(),
    });
    const { _id, __v, ...rest } = job.toObject();
    return { ...rest, id: job.externalId };
  }
}
