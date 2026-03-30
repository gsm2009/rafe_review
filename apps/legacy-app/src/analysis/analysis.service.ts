import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../shared/database/database.service';
import { MessageQueueService } from '../shared/message-queue/message-queue.service';
import { CreateAnalysisDto } from './models/create-analysis.dto';
import type { AnalysisJob, AnalysisRequestedEvent } from '@senior-challenge/shared-types';

/**
 * Analysis Service - 重构后：只负责任务创建和分发，成为纯粹的 API 层
 */
@Injectable()
export class AnalysisService {
    private readonly logger = new Logger(AnalysisService.name);

    constructor(
        private readonly databaseService: DatabaseService,
        private readonly messageQueueService: MessageQueueService,
    ) { }

    /**
     * 重构后：职责单一，仅创建 PENDING 任务并分发消息
     */
    async createAnalysis(dto: CreateAnalysisDto): Promise<AnalysisJob> {
        const jobId = uuidv4();
        const now = new Date().toISOString();

        // ✅ 修复：不再做任何计算，仅创建基础任务
        const job: AnalysisJob = {
            jobId,
            userId: dto.userId,
            dataUrl: dto.dataUrl,
            status: 'PENDING',
            version: 0, // ✅ 强制设置乐观锁初始版本号
            createdAt: now,
            updatedAt: now,
        };

        // 保存到数据库
        await this.databaseService.saveJob(job);
        this.logger.log(`✅ Job created and queued: ${jobId}`);

        // 发送消息给 Worker
        const event: AnalysisRequestedEvent = {
            eventType: 'AnalysisRequested',
            jobId,
            userId: dto.userId,
            dataUrl: dto.dataUrl,
            timestamp: now,
        };

        await this.messageQueueService.publishEvent(event);

        return job;
    }

    /**
     * Gets an analysis job by ID.
     */
    async getAnalysisById(jobId: string): Promise<AnalysisJob | null> {
        return this.databaseService.findJobById(jobId);
    }

    // ✅ 修复：彻底删除 calculateQuickDemographics 和 delayedUpdate 方法
}
