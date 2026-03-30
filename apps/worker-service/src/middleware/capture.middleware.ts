// apps/worker-service/src/middleware/capture.middleware.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import type { AnalysisRequestedEvent } from '@senior-challenge/shared-types';

export type Middleware = (
  event: AnalysisRequestedEvent,
  next: () => Promise<void>
) => Promise<void>;

const ensureDir = async (dirPath: string) => {
  try { await fs.access(dirPath); } catch { await fs.mkdir(dirPath, { recursive: true }); }
};

const safeStringify = (obj: unknown) => {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  }, 2);
};

// 检查该 jobId 是否已保存过
const checkJobExists = async (dir: string, jobId: string) => {
  try {
    const files = await fs.readdir(dir);
    return files.some(f => f.includes(jobId));
  } catch {
    return false;
  }
};

export const captureMiddleware: Middleware = async (event, next) => {
  const isCaptureMode = process.env.CAPTURE_MODE === 'true';

  if (!isCaptureMode) {
    return next();
  }

  try {
    const captureDir = path.resolve(process.cwd(), 'debug-payloads');
    await ensureDir(captureDir);

    const jobId = event?.jobId || `unknown-${Date.now()}`;
    
    // 核心：如果该 jobId 已保存过，直接跳过，不重复生成
    const exists = await checkJobExists(captureDir, jobId);
    if (exists) {
      console.log(`[CaptureMiddleware] Job ${jobId} 已保存过，跳过重复捕获`);
      return next();
    }

    const fileName = `job-${jobId}.json`; // 去掉时间戳，避免重复
    const filePath = path.join(captureDir, fileName);
    await fs.writeFile(filePath, safeStringify(event), 'utf-8');
    console.log(`[CaptureMiddleware] Payload 保存成功: ${fileName}`);
  } catch (err) {
    console.error('[CaptureMiddleware] 保存失败（不影响任务）:', err);
  }

  return next();
};
