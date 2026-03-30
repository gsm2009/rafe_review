/**
 * Facade Service - 包装第三方 Audience API 调用
 * 
 * 修复点：
 * 1. 兼容新/老两种API响应格式（核心BUG）
 * 2. 批量调用共享BrowserContext，提升性能
 * 3. 补充TypeScript类型保护
 * 4. 完善日志和错误边界
 * 5. 统一资源管理
 */

import { chromium, Browser, BrowserContext } from 'playwright';
import { MockAuthPool } from './mock-auth-pool';

// ========== 新增：TypeScript 类型定义（类型保护） ==========
// 新格式响应接口
interface NewAudienceResponse {
  status: 'success' | 'error';
  data: {
    audience: Record<string, any>;
  };
}

// 老格式响应接口
interface OldAudienceResponse {
  status: 'success' | 'error';
  audience_data: {
    demographics: Record<string, any>;
  };
}

// 通用响应类型
type AudienceResponse = NewAudienceResponse | OldAudienceResponse;

// 类型保护：判断是否为新格式
function isNewFormat(response: AudienceResponse): response is NewAudienceResponse {
  return 'data' in response && !!response.data?.audience;
}

// 类型保护：判断是否为老格式
function isOldFormat(response: AudienceResponse): response is OldAudienceResponse {
  return 'audience_data' in response && !!response.audience_data?.demographics;
}

// ========== 核心服务类 ==========
export class FacadeAudienceService {
    private authPool: MockAuthPool;
    private sharedBrowser: Browser | null = null;
    private sharedContext: BrowserContext | null = null;

    constructor() {
        this.authPool = new MockAuthPool();
    }

    /**
     * 初始化共享浏览器上下文（批量调用时复用）
     */
    private async initSharedContext(): Promise<BrowserContext> {
        if (this.sharedContext) return this.sharedContext;
        
        this.sharedBrowser = await chromium.launch({ headless: true });
        this.sharedContext = await this.sharedBrowser.newContext();
        return this.sharedContext;
    }

    /**
     * 获取 Audience 数据（兼容新/老格式 + 类型保护）
     * 
     * @param mediaType - instagram | tiktok
     * @param mediaId - 媒体ID
     * @param context - 可选的共享浏览器上下文
     */
    async getAudienceV1ByPlaywright(
        mediaType: 'instagram' | 'tiktok',
        mediaId: string,
        context?: BrowserContext,
    ): Promise<any> {
        const url = `http://localhost:3001/api/v1/audience?media_type=${mediaType}&media_id=${mediaId}`;

        try {
            // 获取认证（每次请求新auth，避免复用冲突）
            const auth = await this.authPool.getNextAuth();
            const token = await this.authPool.getToken(auth);

            console.log(`[FacadeService] Fetching audience for ${mediaType}:${mediaId}`);
            console.log(`[FacadeService] Using auth: ${auth.username}`);

            let browser: Browser | null = null;
            let shouldCloseBrowser = false;
            let reqContext = context;

            // 上下文管理：优先用共享上下文 → 自定义上下文 → 新建上下文
            if (!reqContext) {
                reqContext = await this.initSharedContext();
            } else if (!this.sharedContext) {
                browser = await chromium.launch({ headless: true });
                reqContext = await browser.newContext();
                shouldCloseBrowser = true;
            }

            // 发起API请求
            const response = await reqContext.request.get(url, {
                headers: {
                    'authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            });

            const audienceData = await response.json();

            // 第一步：校验请求状态
            if (audienceData.status !== 'success') {
                console.error(`[FacadeService] API returned non-success status for ${mediaType}:${mediaId}`);
                return null;
            }

            console.log('[FacadeService] Raw response:', JSON.stringify(audienceData).substring(0, 200));

            // 第二步：用类型保护提取数据（核心修复）
            let extracted: Record<string, any> | null = null;
            const audienceDataTyped = audienceData as AudienceResponse;

            if (isNewFormat(audienceDataTyped)) {
                extracted = audienceDataTyped.data.audience;
                console.log(`[FacadeService] Used NEW format for ${mediaType}:${mediaId}`);
            } else if (isOldFormat(audienceDataTyped)) {
                extracted = audienceDataTyped.audience_data.demographics;
                console.log(`[FacadeService] Used OLD format for ${mediaType}:${mediaId}`);
            } else {
                extracted = null;
                console.error(`[FacadeService] ⚠️ No valid audience data for ${mediaType}:${mediaId}`);
                console.error('[FacadeService] Available keys:', Object.keys(audienceData));
            }

            // 第三步：清理临时资源
            if (shouldCloseBrowser && browser) {
                await browser.close();
            }

            return extracted;

        } catch (error) {
            const errMsg = (error as Error).message;
            // 包装错误，携带mediaType/mediaId便于上层追踪
            const wrappedError = new Error(`[${mediaType}:${mediaId}] ${errMsg}`);
            console.error(`[FacadeService] Failed to fetch audience for ${mediaType}:${mediaId}: ${errMsg}`);
            throw wrappedError;
        }
    }

    /**
     * 批量获取 - 共享BrowserContext，提升并发性能
     */
    async batchGetAudience(requests: Array<{ mediaType: 'instagram' | 'tiktok'; mediaId: string }>) {
        console.log(`[FacadeService] Batch fetching ${requests.length} audience datasets`);

        // 初始化共享上下文，所有批量请求复用
        const sharedContext = await this.initSharedContext();

        try {
            // 并发调用，复用同一个context
            const results = await Promise.all(
                requests.map(req =>
                    this.getAudienceV1ByPlaywright(req.mediaType, req.mediaId, sharedContext)
                )
            );

            const successCount = results.filter(r => r !== null).length;
            console.log(`[FacadeService] Batch complete: ${successCount}/${requests.length} succeeded`);

            return results;
        } catch (batchError) {
            console.error('[FacadeService] Batch fetch failed:', (batchError as Error).message);
            throw batchError;
        }
    }

    /**
     * 清理资源（统一关闭浏览器和上下文）
     */
    async cleanup() {
        if (this.sharedContext) {
            await this.sharedContext.close();
            this.sharedContext = null;
        }
        if (this.sharedBrowser) {
            await this.sharedBrowser.close();
            this.sharedBrowser = null;
        }
    }
}
