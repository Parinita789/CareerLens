import { Controller, Get, Put, Post, Body, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiOkResponse } from '@nestjs/swagger';
import { ProfileService } from './profile.service';
import { ProfileDto } from './dto/profile.dto';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

@ApiTags('profile')
@Controller('profile')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get()
  @ApiOperation({ summary: 'Get the candidate profile (there is exactly one, used by scoring/cover-letters/form-fill).' })
  @ApiOkResponse({ description: 'The profile document.' })
  getProfile() {
    return this.profileService.getProfile();
  }

  @Put()
  @ApiOperation({ summary: 'Update the candidate profile. Top-level keys are $set — omitted keys are left untouched.' })
  @ApiOkResponse({ description: 'The updated profile document.' })
  updateProfile(@Body() profile: ProfileDto) {
    return this.profileService.updateProfile(profile);
  }

  @Post('upload-resume')
  @ApiOperation({ summary: 'Upload a resume PDF and have the LLM parse it into a new candidate profile.' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { resume: { type: 'string', format: 'binary', description: 'Resume PDF, max 10MB.' } },
    },
  })
  @ApiOkResponse({ description: 'The parsed profile document, or { error } on failure.' })
  @UseInterceptors(FileInterceptor('resume', {
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype !== 'application/pdf') {
        cb(new BadRequestException('Only PDF files are allowed') as any, false);
        return;
      }
      cb(null, true);
    },
  }))
  async uploadResume(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      return { error: 'No file uploaded' };
    }
    try {
      // Sanitize filename — strip path traversal, special chars
      const safeName = (file.originalname || 'resume.pdf')
        .replace(/\.\./g, '')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(-50);
      return await this.profileService.parseResumeAndCreateProfile(file.buffer, safeName);
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
}
