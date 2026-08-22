import { Controller, Get, Post, Put, Delete, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiBody, ApiOkResponse } from '@nestjs/swagger';
import { FormAnswersService } from './form-answers.service';
import { AddPendingQuestionDto } from './dto/add-pending-question.dto';
import { AnswerPendingQuestionDto } from './dto/answer-pending-question.dto';

@ApiTags('form-answers')
@Controller('form-answers')
export class FormAnswersController {
  constructor(private readonly service: FormAnswersService) {}

  @Get('logs')
  @ApiOperation({ summary: 'Get the full history of application-form questions and how they were answered.' })
  @ApiOkResponse({ description: 'Array of per-job Q&A log entries.' })
  getLogs() {
    return this.service.getFormAnswers();
  }

  @Get('rules')
  @ApiOperation({ summary: 'Get all saved answer rules (question pattern → answer).' })
  @ApiOkResponse({ description: 'Map of question pattern to saved answer.' })
  getRules() {
    return this.service.getRules();
  }

  @Put('rules')
  @ApiOperation({ summary: 'Replace the entire set of saved answer rules.' })
  @ApiBody({
    description: 'Map of question pattern to answer. Replaces all existing rules.',
    schema: {
      type: 'object',
      additionalProperties: { type: 'string' },
      example: { 'years of experience': '7', 'visa sponsorship': 'No' },
    },
  })
  @ApiOkResponse({ description: 'The saved rules map.' })
  saveRules(@Body() rules: Record<string, string>) {
    return this.service.saveRules(rules);
  }

  // ── Pending Questions ──

  @Post('pending')
  @ApiOperation({ summary: 'Post a question the bot couldn\'t answer automatically, for the user to answer in the UI.' })
  @ApiOkResponse({ description: 'The created pending question.' })
  addPending(@Body() body: AddPendingQuestionDto) {
    return this.service.addPendingQuestion(body as any);
  }

  @Get('pending')
  @ApiOperation({ summary: 'List unanswered pending questions.' })
  @ApiOkResponse({ description: 'Array of pending questions.' })
  getPending() {
    return this.service.getPendingQuestions();
  }

  @Get('pending/:id')
  @ApiOperation({ summary: 'Get a single pending question by ID (used by the bot to poll for the user\'s answer).' })
  @ApiParam({ name: 'id', description: 'Pending question ID.' })
  @ApiOkResponse({ description: 'The pending question, or null if not found.' })
  getQuestion(@Param('id') id: string) {
    return this.service.getQuestion(id);
  }

  @Post('pending/:id/answer')
  @ApiOperation({ summary: 'Submit the user\'s answer to a pending question.' })
  @ApiParam({ name: 'id', description: 'Pending question ID.' })
  @ApiOkResponse({ description: 'The answered question, or null if not found.' })
  answerPending(@Param('id') id: string, @Body() body: AnswerPendingQuestionDto) {
    return this.service.answerPendingQuestion(id, body.answer, body.saveAsRule ?? true);
  }

  @Delete('pending')
  @ApiOperation({ summary: 'Clear all pending questions.' })
  @ApiOkResponse({ description: 'Cleared.' })
  clearPending() {
    this.service.clearPendingQuestions();
    return { message: 'Cleared' };
  }
}
