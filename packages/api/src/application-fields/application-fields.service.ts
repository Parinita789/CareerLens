import { Injectable, NotFoundException } from '@nestjs/common';
import { ApplicationFieldsModel, ProfileAnswerModel } from '@careerlens/shared';

@Injectable()
export class ApplicationFieldsService {
  async getAll(): Promise<any[]> {
    const docs = await ApplicationFieldsModel.find()
      .sort({ unknownCount: -1, scrapedAt: -1 })
      .lean();
    return docs.map((d: any) => {
      const { _id, __v, ...rest } = d;
      return rest;
    });
  }

  async getByJobId(externalJobId: string): Promise<any> {
    const doc = await ApplicationFieldsModel.findOne({ externalJobId }).lean();
    if (!doc) throw new NotFoundException(`Application fields not found for job ${externalJobId}`);
    const { _id, __v, ...rest } = doc as any;
    return rest;
  }

  async updateField(
    externalJobId: string,
    fieldIndex: number,
    value: string,
    saveAsRule: boolean,
  ): Promise<any> {
    const doc = await ApplicationFieldsModel.findOne({ externalJobId });
    if (!doc) throw new NotFoundException(`Application fields not found for job ${externalJobId}`);

    const field = doc.fields[fieldIndex];
    if (!field) throw new NotFoundException(`Field at index ${fieldIndex} not found`);

    field.value = value;
    field.source = 'rule';

    // Recalculate unknown count
    doc.unknownCount = doc.fields.filter(
      (f: any) => f.source === 'unknown' && f.type !== 'file',
    ).length;
    doc.status = doc.unknownCount === 0 ? 'ready' : 'needs_review';

    await doc.save();

    // Save as rule for future auto-fill
    if (saveAsRule && value.length < 500) {
      const normalized = field.label
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (normalized.length >= 3) {
        await ProfileAnswerModel.findOneAndUpdate(
          { question_pattern: normalized },
          { $set: { answer: value, source: 'manual' } },
          { upsert: true },
        ).catch(() => {});
      }
    }

    const { _id, __v, ...rest } = doc.toObject();
    return rest;
  }

  async updateStatus(externalJobId: string, status: string): Promise<any> {
    const doc = await ApplicationFieldsModel.findOneAndUpdate(
      { externalJobId },
      { $set: { status } },
      { new: true },
    ).lean();
    if (!doc) throw new NotFoundException(`Application fields not found for job ${externalJobId}`);
    const { _id, __v, ...rest } = doc as any;
    return rest;
  }

  async deleteByJobId(externalJobId: string): Promise<void> {
    await ApplicationFieldsModel.deleteOne({ externalJobId });
  }
}
