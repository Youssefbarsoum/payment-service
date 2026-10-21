import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Queue } from 'bullmq';
import { JOBS_QUEUE } from '../queue/jobs.js';
import { AdminGuard } from './admin.guard.js';

/** The dead-letter queue: jobs that exhausted their retries, for inspection and manual replay. */
@ApiTags('admin')
@ApiSecurity('admin')
@Controller('admin/jobs')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(@InjectQueue(JOBS_QUEUE) private readonly queue: Queue) {}

  @Get('failed')
  async failed() {
    const jobs = await this.queue.getFailed(0, 99);
    return jobs.map((j) => ({
      id: j.id,
      name: j.name,
      data: j.data,
      attemptsMade: j.attemptsMade,
      failedReason: j.failedReason,
      finishedOn: j.finishedOn,
    }));
  }

  @Post(':id/retry')
  @HttpCode(202)
  async retry(@Param('id') id: string) {
    const job = await this.queue.getJob(id);
    if (!job) {
      throw new NotFoundException({
        code: 'job_not_found',
        message: 'Job not found',
      });
    }
    if (!(await job.isFailed())) {
      throw new ConflictException({
        code: 'job_not_failed',
        message: 'Only failed jobs can be retried',
      });
    }
    await job.retry();
    return { id, status: 'waiting' };
  }
}
