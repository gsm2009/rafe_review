import * as fs from 'fs/promises';
import * as path from 'path';
import type { AnalysisRequestedEvent } from '@senior-challenge/shared-types';

const FAILED_RECORDS_DIR = path.resolve(process.cwd(), 'failed-records');

// 确保目录存在
const ensureDir = async () => {
  try {
    await fs.access(FAILED_RECORDS_DIR);
  } catch {
    await fs.mkdir(FAILED_RECORDS_DIR, { recursive: true });
  }
};

// 失败记录类型
export interface FailedRecord {
  jobId: string;
  traceId?: string;
  rawPayload: AnalysisRequestedEvent;
  error: string;
  failedAt: string;
}

// 批量保存失败记录
export const saveFailedRecords = async (
  records: FailedRecord[],
  batchId?: string
): Promise<{ batchId: string; filePath: string; count: number }> => {
  if (records.length === 0) {
    return { batchId: batchId || `batch-${Date.now()}`, filePath: '', count: 0 };
  }

  await ensureDir();
  const finalBatchId = batchId || `batch-${Date.now()}`;
  const fileName = `${finalBatchId}.json`;
  const filePath = path.join(FAILED_RECORDS_DIR, fileName);

  await fs.writeFile(
    filePath,
    JSON.stringify({
      batchId: finalBatchId,
      failedAt: new Date().toISOString(),
      count: records.length,
      records
    }, null, 2),
    'utf-8'
  );

  return { batchId: finalBatchId, filePath, count: records.length };
};
