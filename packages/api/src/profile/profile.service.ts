import { Injectable, NotFoundException } from '@nestjs/common';
import { UserModel, llmChat } from '@job-agent/shared';
import * as fs from 'fs';
import * as path from 'path';

const pdfParse = require('pdf-parse');
const RESUME_DIR = path.resolve(__dirname, '../../../scraper/data/resume');

@Injectable()
export class ProfileService {
  async getProfile(): Promise<any> {
    const user = await UserModel.findOne().lean();
    if (!user) throw new NotFoundException('No profile found. Upload a resume to create one.');
    return user;
  }

  async updateProfile(profile: any): Promise<any> {
    profile.meta = {
      ...profile.meta,
      last_updated: new Date().toISOString().split('T')[0],
    };

    const updated = await UserModel.findOneAndUpdate(
      {},
      { $set: profile },
      { upsert: true, new: true },
    ).lean();

    return updated;
  }

  async parseResumeAndCreateProfile(fileBuffer: Buffer, fileName: string): Promise<any> {
    console.log('[Resume] Starting...');

    // Save resume to scraper/data/resume/
    fs.mkdirSync(RESUME_DIR, { recursive: true });
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const resumePath = path.join(RESUME_DIR, safeName);
    fs.writeFileSync(resumePath, fileBuffer);
    console.log(`[Resume] Saved to: ${resumePath}`);

    // Extract text from PDF
    let resumeText: string;
    try {
      const pdf = await pdfParse(fileBuffer);
      resumeText = pdf.text;
      console.log(`[Resume] Extracted ${resumeText.length} chars`);
    } catch (err) {
      console.error('[Resume] PDF parse failed:', (err as Error).message);
      throw new Error(`Failed to read PDF: ${(err as Error).message}`);
    }

    if (!resumeText || resumeText.length < 50) {
      throw new Error('Could not extract text from PDF');
    }

    const prompt = `Extract a candidate profile from this resume as JSON. No markdown, no explanation, ONLY the JSON object.
                    Fields: personal{name,email,phone,location,linkedin,github}, experience{total_years,current_level,summary}, skills{languages[],frameworks[],databases[],messaging[],cloud[],devops[],architecture[],ai[],tools[],methodologies[]}, top_achievements[{company,impact}] (2-4 with metrics), work_history[{company,location,title,start,end,duration_years}], preferences{target_roles[],location{current_city,remote:true,hybrid_us:true,onsite:true},employment_type:["full-time"],preferred_domains[]}, compensation{base_salary_min:0,base_salary_preferred:0}, deal_breakers[], strengths_for_agent{use_for_cover_letter[],ats_keywords[]}
                    Resume:
                    ${resumeText.slice(0, 4000)}`;

    console.log('[Resume] Sending to LLM...');
    const startTime = Date.now();
    let responseText: string;
    try {
      responseText = await llmChat(prompt, {
        system: 'Respond with ONLY valid JSON. No markdown, no explanation.',
        jsonMode: true,
        maxTokens: 4096,
      });
    } catch (err) {
      console.error('[Resume] LLM failed:', (err as Error).message);
      throw new Error(`Resume parsing failed: ${(err as Error).message}`);
    }
    console.log(
      `[Resume] Response: ${responseText.length} chars in ${((Date.now() - startTime) / 1000).toFixed(1)}s`,
    );

    // Extract JSON
    let jsonStr = responseText;
    const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    } else {
      const firstBrace = responseText.indexOf('{');
      const lastBrace = responseText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        jsonStr = responseText.slice(firstBrace, lastBrace + 1);
      }
    }

    let profile;
    try {
      profile = JSON.parse(jsonStr);
    } catch {
      console.error('Failed to parse JSON. Raw:', responseText.slice(0, 500));
      throw new Error('LLM returned invalid JSON. Try uploading again.');
    }

    // Save to DB
    console.log('[Resume] Saving profile to database...');
    const saved = await UserModel.findOneAndUpdate(
      {},
      { $set: profile },
      { upsert: true, new: true },
    ).lean();

    return saved;
  }
}
