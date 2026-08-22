import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { saveCoverLetter } from '../../persistence/db';
import type { ScoredJob } from '../../types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class GreenhouseAttachmentService {
  async handleCoverLetterField(page: Page, job: ScoredJob): Promise<void> {
    console.log('    Checking for cover letter field...');

    // Find the cover letter section by its label, then find the "Enter manually" button within it
    const coverLetterSection = await page.$('#upload-label-cover_letter, [id*="cover_letter"]');
    if (!coverLetterSection) {
      console.log('    No cover letter section found');
      return;
    }

    // Find the "Enter manually" button near the cover letter section
    // Get all "Enter manually" buttons and click the one associated with cover letter
    const allEnterBtns = await page.$$('button:has-text("Enter manually")');
    console.log(`    Found ${allEnterBtns.length} "Enter manually" button(s)`);

    // Click the LAST one — Greenhouse shows resume first, then cover letter
    // So the second "Enter manually" is for cover letter
    let clickedBtn = false;
    if (allEnterBtns.length >= 2) {
      console.log('    Clicking "Enter manually" for cover letter (2nd button)...');
      await allEnterBtns[allEnterBtns.length - 1].click();
      clickedBtn = true;
    } else if (allEnterBtns.length === 1) {
      // Only one button — check if resume is already uploaded (file input has value)
      const resumeInput = await page.$('input[type="file"][id="resume"]');
      const resumeValue = resumeInput
        ? await resumeInput.evaluate((el: any) => el.files?.length > 0).catch(() => false)
        : false;
      if (resumeValue) {
        // Resume already uploaded, this button must be for cover letter
        console.log('    Clicking "Enter manually" for cover letter...');
        await allEnterBtns[0].click();
        clickedBtn = true;
      }
    }

    // Load existing cover letter (pre-scraped or from DB) — avoid regeneration
    let coverLetter = '';
    const { ApplicationFieldsModel } = await import('@job-agent/shared');
    const preFilled = (await ApplicationFieldsModel.findOne({ externalJobId: job.id })
      .lean()
      .catch(() => null)) as any;
    if (preFilled?.coverLetter) {
      coverLetter = preFilled.coverLetter;
    }
    if (!coverLetter) {
      const { CoverLetterModel } = await import('../../persistence/db');
      const existing = await CoverLetterModel.findOne({ externalJobId: job.id })
        .sort({ generatedAt: -1 })
        .lean()
        .catch(() => null);
      if ((existing as any)?.content) coverLetter = (existing as any).content;
    }

    if (clickedBtn) {
      await sleep(800);
    }

    // Look for the textarea — try multiple selectors and retry once
    let coverLetterTextarea = await page.$(
      'textarea[id*="cover_letter"], textarea[name*="cover_letter"]',
    );

    if (!coverLetterTextarea && coverLetterSection) {
      const parent = await coverLetterSection.evaluateHandle(
        (el: Element) =>
          el.closest('.field, .upload-field, [class*="field"]') || el.parentElement?.parentElement,
      );
      if (parent) {
        coverLetterTextarea = await parent.$('textarea');
      }
    }

    // Retry — textarea may take a moment to render after button click
    if (!coverLetterTextarea && clickedBtn) {
      await sleep(500);
      coverLetterTextarea = await page.$(
        'textarea[id*="cover_letter"], textarea[name*="cover_letter"]',
      );
      if (!coverLetterTextarea) {
        // Try any textarea near cover letter section
        coverLetterTextarea = await page.$('[class*="cover"] textarea, [id*="cover"] textarea');
      }
    }

    if (!coverLetterTextarea) {
      console.log('    No cover letter textarea — using file upload');
      const fileUpload = await page.$('input[type="file"][id="cover_letter"]');
      if (fileUpload && coverLetter) {
        try {
          const tempDir = path.join(__dirname, '../../../data/cover-letters');
          fs.mkdirSync(tempDir, { recursive: true });
          const filename = `${job.company.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-cover-letter.txt`;
          const filepath = path.join(tempDir, filename);
          fs.writeFileSync(filepath, coverLetter);
          await fileUpload.setInputFiles(filepath);
          if (!preFilled?.coverLetter) await saveCoverLetter(job.id, coverLetter);
          console.log(`    ✓ Cover letter uploaded as file (${coverLetter.length} chars)`);
        } catch (err) {
          console.log(`    Cover letter upload failed: ${(err as Error).message}`);
        }
      } else if (!coverLetter) {
        console.log('    No cover letter generated yet for this job — skipping upload');
      }
      return;
    }

    const existingText = await coverLetterTextarea.inputValue().catch(() => '');
    if (existingText) {
      console.log('    Cover letter already filled');
      return;
    }

    if (!coverLetter) {
      console.log('    No cover letter generated yet for this job — skipping');
      return;
    }

    // Fill it directly into the form
    await coverLetterTextarea.fill(coverLetter);
    console.log(`    ✓ Cover letter filled in form (${coverLetter.length} chars)`);

    // Save to database for the Cover Letters tab
    if (!preFilled?.coverLetter) await saveCoverLetter(job.id, coverLetter);
  }

  async handleResumeUpload(page: Page): Promise<void> {
    // Target specifically the resume upload, not the cover letter one
    const fileInput = await page.$(
      'input[type="file"][id="resume"], input[type="file"][name*="resume"]',
    );
    if (!fileInput) return;

    const resumeDir = path.join(__dirname, '../../../data/resume');
    let resumePath = '';

    // Find any PDF in the resume directory
    try {
      const files = fs.readdirSync(resumeDir).filter((f: string) => f.toLowerCase().endsWith('.pdf'));
      if (files.length > 0) {
        resumePath = path.join(resumeDir, files[0]);
      }
    } catch {
      /* dir doesn't exist */
    }

    if (!resumePath) {
      console.log('    No resume PDF found in data/resume/, skipping upload');
      return;
    }

    await fileInput.setInputFiles(resumePath);
    console.log('    Uploaded resume');
    await sleep(1000);
  }
}
