import { Injectable } from '@nestjs/common';
import { QuestionAnswerModel, ProfileAnswerModel } from '@job-agent/shared';
import { randomUUID } from 'crypto';

export interface PendingQuestion {
  id: string;
  jobTitle: string;
  company: string;
  question: string;
  type: 'text' | 'textarea' | 'select' | 'radio';
  options?: string[];
  defaultValue?: string;
  answer?: string;
  answeredAt?: string;
  createdAt: string;
}

@Injectable()
export class FormAnswersService {
  private pendingQuestions: Map<string, PendingQuestion> = new Map();

  addPendingQuestion(data: Omit<PendingQuestion, 'id' | 'createdAt'>): PendingQuestion {
    const q: PendingQuestion = {
      ...data,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.pendingQuestions.set(q.id, q);
    return q;
  }

  getPendingQuestions(): PendingQuestion[] {
    return Array.from(this.pendingQuestions.values()).filter((q) => !q.answer);
  }

  getQuestion(id: string): PendingQuestion | null {
    return this.pendingQuestions.get(id) || null;
  }

  async answerPendingQuestion(
    id: string,
    answer: string,
    saveAsRule: boolean,
  ): Promise<PendingQuestion | null> {
    const q = this.pendingQuestions.get(id);
    if (!q) return null;
    q.answer = answer;
    q.answeredAt = new Date().toISOString();

    // Save as rule for future auto-fill — skip bot-internal questions
    const questionLower = q.question.toLowerCase();
    const isBotInternal =
      questionLower.includes('review the form') ||
      questionLower.includes('confirm submission') ||
      questionLower.includes('cover letter for') ||
      questionLower.includes('bot will detect') ||
      questionLower.includes('choose an option below') ||
      answer === 'auto-detected' ||
      answer === '__SKIP__' ||
      answer.length > 300 ||
      answer.includes('+93') ||
      answer.includes('Afghanistan');

    if (saveAsRule && !isBotInternal) {
      const normalized = questionLower
        .replace(/\(pick one\)/g, '')
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      console.log(`[FormAnswers] Saving rule: "${normalized}" → "${answer}"`);
      try {
        await ProfileAnswerModel.findOneAndUpdate(
          { question_pattern: normalized },
          { $set: { answer, source: 'manual' } },
          { upsert: true },
        );
        console.log(`[FormAnswers] ✓ Rule saved: "${normalized}"`);
      } catch (err: any) {
        console.error(`[FormAnswers] ✗ Failed to save rule: ${err.message}`);
      }
    } else if (!isBotInternal) {
      console.log(
        `[FormAnswers] Not saving (saveAsRule=${saveAsRule}): "${questionLower.slice(0, 50)}"`,
      );
    }

    return q;
  }

  clearPendingQuestions(): void {
    this.pendingQuestions.clear();
  }
  async getFormAnswers(): Promise<any[]> {
    return QuestionAnswerModel.find().sort({ appliedAt: -1 }).lean();
  }

  async getRules(): Promise<Record<string, string>> {
    const rules = await ProfileAnswerModel.find().lean();
    if (rules.length === 0) {
      // Return defaults
      return {
        'authorized to work': 'Yes',
        'legally authorized': 'Yes',
        'visa sponsorship': 'No',
        'require sponsorship': 'No',
        'years of experience': '7',
        'how many years': '7',
        'expected salary': '180000',
        'desired salary': '180000',
        'salary expectation': '180000',
        'current salary': '160000',
        'start date': '2 weeks',
        'when can you start': '2 weeks',
        remote: 'Yes',
        'willing to relocate': 'Yes',
      };
    }
    return rules.reduce(
      (acc, r) => {
        acc[r.question_pattern] = r.answer;
        return acc;
      },
      {} as Record<string, string>,
    );
  }

  async saveRules(rules: Record<string, string>): Promise<Record<string, string>> {
    // Clear and re-insert all rules
    await ProfileAnswerModel.deleteMany({});
    const docs = Object.entries(rules).map(([question_pattern, answer]) => ({
      question_pattern,
      answer,
      source: 'manual',
    }));
    if (docs.length > 0) {
      await ProfileAnswerModel.insertMany(docs);
    }
    return rules;
  }
}
