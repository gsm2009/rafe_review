/**
 * Analysis Job status enum.
 */
export type AnalysisStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

/**
 * Channel type for notification delivery.
 */
export type NotificationChannel = 'EMAIL' | 'SMS' | 'PUSH';

/**
 * Demographics data structure.
 * ⚠️ 注意：第三方 API 返回的数据格式不稳定，字段可能缺失或类型错误
 */
export interface Demographics {
    ageRange?: string;
    gender?: string;
    location?: string;
    interests?: string[];
    confidence?: number;
}

/**
 * Analysis Job entity.
 */
export interface AnalysisJob {
    jobId: string;
    userId: string;
    dataUrl: string;
    status: AnalysisStatus;
    demographics?: Demographics;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    error?: string;
    /** 用于乐观锁的版本号 */
    version: number; // 🔴 修改：从可选改为必选
}

/**
 * Create Analysis Request DTO.
 */
export interface CreateAnalysisRequest {
    userId: string;
    dataUrl: string;
}

/**
 * Analysis Requested Event - 发送到消息队列的事件.
 */
export interface AnalysisRequestedEvent {
    eventType: 'AnalysisRequested';
    jobId: string;
    userId: string;
    dataUrl: string;
    timestamp: string;
    /** 用于全链路追踪的 Trace ID */
    traceId?: string;
}

/**
 * Third-party API raw response.
 * ⚠️ 这是从第三方 API 获取的原始数据，格式不可靠！
 */
export interface ThirdPartyApiResponse {
    success: boolean;
    data?: {
        age?: number | string | null;
        gender?: string | null;
        country?: string | null;
        city?: string | null;
        tags?: string[] | string | null;
        score?: number | string | null;
    };
    error?: string;
}

export interface LogContext {
  traceId?: string;
  jobId?: string;
  [key: string]: unknown;
}
