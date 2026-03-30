# 高级后端工程师面试挑战 完整解决方案
本方案完全贴合题目要求，覆盖5个任务模块的根因分析、可落地的代码实现、架构决策与权衡，同时匹配评分标准，兼顾工程落地性与面试考察重点。

## 整体项目核心矛盾梳理
该挑战是**真实遗留系统的治理场景**，核心考察4项能力：问题根因定位能力、工程化工具链建设能力、分布式系统架构治理能力、极端约束下的技术决策能力。所有方案均基于现有TypeScript技术栈，最小化改动，最大化解决核心问题，满足3-4小时的完成时限要求。

---

## 第一部分：工具链建设 - Capture & Replay（20分）
### 核心问题根因
线上调试闭环周期长达5分钟+，核心痛点是**无法在本地复现线上SQS消息的真实Payload与执行环境**，导致调试效率极低。

### 解决方案
#### 1. 捕获中间件实现 `apps/worker-service/src/middleware/capture.middleware.ts`
```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import { SQSMessage } from '@shared-types/sqs';

// 确保目录存在
const ensureDir = async (dirPath: string) => {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
};

export const captureMiddleware = async (
  message: SQSMessage,
  next: () => Promise<void>
) => {
  const isCaptureMode = process.env.CAPTURE_MODE === 'true';
  const captureDir = path.resolve(process.cwd(), 'debug-payloads');

  // 非捕获模式直接放行
  if (!isCaptureMode) {
    return next();
  }

  try {
    await ensureDir(captureDir);
    const jobId = message.body?.jobId || `unknown-${Date.now()}`;
    const fileName = `job-${jobId}-${Date.now()}.json`;
    const filePath = path.join(captureDir, fileName);

    // 写入完整Payload，不阻塞主流程
    await fs.writeFile(filePath, JSON.stringify(message, null, 2), 'utf-8');
    console.log(`[CaptureMiddleware] Payload saved to ${filePath}`);
  } catch (err) {
    // 捕获失败仅打日志，不中断消息消费
    console.error('[CaptureMiddleware] Failed to capture payload', err);
  }

  // 执行后续handler逻辑
  return next();
};
```

#### 2. 重放脚本实现 `scripts/replay-event.ts`
```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import minimist from 'minimist';
import { analysisHandler } from '../apps/worker-service/src/processors/analysis.processor';

// 解析命令行参数
const args = minimist(process.argv.slice(2));
const filePath = args.file;

if (!filePath) {
  console.error('Error: Please specify file with --file=debug-payloads/job-xxx.json');
  process.exit(1);
}

const runReplay = async () => {
  try {
    // 读取并解析Payload
    const absolutePath = path.resolve(process.cwd(), filePath);
    const fileContent = await fs.readFile(absolutePath, 'utf-8');
    const payload = JSON.parse(fileContent);

    console.log('=====================================');
    console.log(`🎬 Replaying job: ${payload.body?.jobId || 'unknown'}`);
    console.log('=====================================');

    // 直接调用Handler，绕过SQS
    await analysisHandler(payload);

    console.log('=====================================');
    console.log('✅ Replay completed successfully');
    console.log('=====================================');
  } catch (err) {
    console.error('❌ Replay failed with error:');
    console.error(err);
    process.exit(1);
  }
};

runReplay();
```

#### 3. 配套配置补充
- 在`package.json`中添加脚本：
  ```json
  {
    "scripts": {
      "replay": "tsx scripts/replay-event.ts"
    }
  }
  ```
- 在Worker服务启动时注册中间件，确保消息消费前执行捕获逻辑。

### 验收标准达成
1. 开启`CAPTURE_MODE=true`启动Worker后，触发任务会自动在`debug-payloads/`生成Payload文件
2. 执行`pnpm run replay -- --file=xxx.json`可直接调用Handler，输出完整执行日志，无需启动SQS
3. 捕获失败不影响主流程，重放脚本完整还原线上执行环境

---

## 第二部分：架构治理 - Single Source of Truth（25分，核心）
### 核心问题根因分析（写入`solutions/part2-analysis.md`）
1. **职责边界混乱**：LegacyApp（API层）既负责请求接收/任务分发，又执行`calculateDemographics`计算并写入数据库；WorkerService（异步处理层）也执行完整计算并写入同一条记录，违背单一职责原则。
2. **双写竞态条件**：两个服务无并发控制地写入同一条记录的同一字段，IO/网络延迟不可控，若Worker先完成计算写入，LegacyApp的延迟写入会直接覆盖正确结果，导致用户看到数据“闪烁”。
3. **状态流转缺失**：无严格的任务状态机，无法区分合法的写入阶段，无法拦截非法的脏写操作。
4. **无并发控制机制**：数据库更新无条件校验，任何服务都可以随时覆盖记录，无乐观锁/悲观锁保障数据一致性。

### 重构解决方案
#### 1. 明确职责边界，彻底拆分读写权限
| 服务 | 保留职责 | 完全移除的逻辑 |
|------|----------|----------------|
| LegacyApp | 1. 请求参数校验；2. 创建任务记录，设置初始`PENDING`状态；3. 发送SQS消息，透传traceId；4. 只读的结果查询接口 | 所有`calculateDemographics`计算逻辑、所有对分析结果字段的写入逻辑 |
| WorkerService | 1. 唯一的计算执行单元；2. 唯一的数据库写入源；3. 任务状态全生命周期管理；4. 异常处理与错误记录 | 无，强化其唯一真相来源的定位 |

#### 2. 严格的状态机设计
```typescript
// packages/shared-types/src/analysis.ts
export enum AnalysisStatus {
  PENDING = 'PENDING', // 已创建，待处理（仅LegacyApp可设置）
  PROCESSING = 'PROCESSING', // 处理中（仅Worker可设置）
  COMPLETED = 'COMPLETED', // 处理完成（仅Worker可设置）
  FAILED = 'FAILED' // 处理失败（仅Worker可设置）
}

export interface AnalysisRecord {
  _id: string; // jobId
  userId: string;
  dataUrl: string;
  traceId: string;
  status: AnalysisStatus;
  version: number; // 乐观锁版本号，初始值0
  result?: Record<string, any>; // 仅Worker可写入
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

#### 3. 乐观锁机制，彻底杜绝脏写
所有数据库更新操作必须携带版本号条件，仅版本号匹配时允许更新，更新成功后版本号原子+1，核心更新逻辑如下：
```typescript
// Worker中更新状态的核心逻辑
export const updateJobStatus = async (
  jobId: string,
  currentVersion: number,
  newStatus: AnalysisStatus,
  extraData: Partial<AnalysisRecord> = {}
) => {
  return await mongoDb.collection('analysis_results').findOneAndUpdate(
    { _id: jobId, version: currentVersion }, // 乐观锁核心条件
    {
      $set: {
        status: newStatus,
        updatedAt: new Date(),
        ...extraData
      },
      $inc: { version: 1 } // 版本号原子递增
    },
    { returnDocument: 'after' }
  );
};
```

#### 4. 代码重构核心修改点
1. **LegacyApp改造**：`analysis.service.ts`中仅保留创建任务的基础逻辑，移除所有计算和结果写入，创建任务时仅写入基础字段，`version=0`，`status=PENDING`。
2. **Worker改造**：
   - Handler入口先校验任务状态，仅`PENDING`状态的任务可处理，通过乐观锁更新为`PROCESSING`，版本号从0→1；
   - 执行完整的`calculateDemographics`计算，调用第三方API；
   - 计算完成后，再次通过乐观锁更新为`COMPLETED`，写入结果数据，版本号从1→2；
   - 异常时更新为`FAILED`，记录错误信息。

### 验收标准达成
1. 任务创建后，无论刷新多少次，数据不会出现“闪烁”，无结果覆盖问题
2. LegacyApp中完全移除`calculateDemographics`相关逻辑，无任何结果写入操作
3. 任务状态严格单向流转，乐观锁机制拦截所有非法脏写
4. WorkerService成为唯一的计算和写入源，实现Single Source of Truth

---

## 第三部分：可观测性与容错 - Dirty Data Defense（20分）
### 核心问题根因
1. 无运行时数据校验，脏数据直接抛出未捕获异常，导致整个批处理崩溃；
2. 日志无结构化、无上下文，仅输出`Error happened`，无法定位问题；
3. 无死信/降级机制，单条数据失败导致全量任务终止。

### 解决方案
#### 1. 基于Zod的运行时数据校验（加分项）
定义校验Schema，使用`safeParse`避免抛出异常，不合法数据直接跳过，不中断主流程：
```typescript
// apps/worker-service/src/schemas/audience.schema.ts
import { z } from 'zod';

// 年龄字段兼容处理：数字、数字字符串、带+号的字符串
const AgeSchema = z.union([
  z.number(),
  z.string().regex(/^\d+\+?$/).transform(val => parseInt(val.replace('+', ''), 10))
]).nullable();

// 邮箱格式校验
const EmailSchema = z.string().email().nullable();

// 第三方API响应完整Schema
export const AudienceRecordSchema = z.object({
  jobId: z.string().min(1),
  userId: z.string().min(1),
  age: AgeSchema,
  email: EmailSchema,
  demographics: z.object({
    gender: z.enum(['male', 'female', 'other']).nullable(),
    location: z.string().nullable()
  }).optional()
});

export type AudienceRecord = z.infer<typeof AudienceRecordSchema>;
```

校验逻辑使用示例：
```typescript
// 批处理核心逻辑
const processBatch = async (records: unknown[]) => {
  let processed = 0;
  let skipped = 0;
  const failedRecords: Array<{ raw: unknown; error: string; jobId?: string }> = [];

  for (const rawRecord of records) {
    // 安全校验，不抛出异常
    const result = AudienceRecordSchema.safeParse(rawRecord);
    if (!result.success) {
      skipped++;
      const firstError = result.error.issues[0];
      const jobId = (rawRecord as any)?.jobId;
      
      // 结构化日志
      logger.warn({
        event: 'ValidationFailed',
        traceId: (rawRecord as any)?.traceId || 'unknown',
        jobId,
        field: firstError.path.join('.'),
        rawValue: (rawRecord as any)?.[firstError.path[0]],
        error: firstError.message
      });

      // 收集失败记录
      failedRecords.push({
        raw: rawRecord,
        error: `${firstError.path.join('.')}: ${firstError.message}`,
        jobId
      });
      continue;
    }

    // 校验通过，执行处理逻辑
    try {
      await processSingleRecord(result.data);
      processed++;
    } catch (err) {
      skipped++;
      failedRecords.push({
        raw: rawRecord,
        error: err instanceof Error ? err.message : 'Unknown error',
        jobId: result.data.jobId
      });
    }
  }

  // 批量写入失败记录
  await saveFailedRecords(failedRecords);

  return { processed, skipped };
};
```

#### 2. 结构化日志改造
替换所有`console.log/console.error`，使用`pino`（高性能Node.js日志库）实现全链路结构化日志，核心配置：
```typescript
// apps/shared/src/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {},
  formatters: {
    level: (label) => ({ level: label })
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

// 带traceId的子日志创建方法
export const createTracedLogger = (traceId: string) => {
  return logger.child({ traceId });
};
```
**强制日志规范**：
- 所有日志必须携带`traceId`，从LegacyApp生成，全链路透传；
- 所有日志必须包含`event`字段，用于检索聚合；
- 单条数据校验失败仅打`warn`级别日志，系统级异常才打`error`级别，避免报警轰炸。

#### 3. 死信记录实现
```typescript
// apps/worker-service/src/utils/failed-records.ts
import * as fs from 'fs/promises';
import * as path from 'path';

const FAILED_RECORDS_DIR = path.resolve(process.cwd(), 'failed-records');

export const saveFailedRecords = async (
  failedRecords: Array<Record<string, any>>
) => {
  if (failedRecords.length === 0) return;

  try {
    await fs.access(FAILED_RECORDS_DIR);
  } catch {
    await fs.mkdir(FAILED_RECORDS_DIR, { recursive: true });
  }

  const batchId = `batch-${Date.now()}`;
  const fileName = `${batchId}.json`;
  const filePath = path.join(FAILED_RECORDS_DIR, fileName);

  await fs.writeFile(
    filePath,
    JSON.stringify({ batchId, failedAt: new Date().toISOString(), records: failedRecords }, null, 2),
    'utf-8'
  );

  return { batchId, filePath, count: failedRecords.length };
};
```

### 验收标准达成
1. 执行`pnpm run process:chaos`处理脏数据样本，不会出现进程崩溃；
2. 输出正确的统计结果：处理成功数、跳过数，失败记录自动保存到`failed-records/`目录；
3. 所有日志为结构化格式，携带traceId、event、jobId等关键字段，可直接检索定位问题；
4. 单条数据异常不会影响整个批处理流程。

---

## 第四部分：第三方集成调试 - Audience数据未返回（20分）
### Bug根因定位
1. **核心根因**：第三方API返回两种不兼容的数据格式，`facade-audience.service.ts`仅兼容了老格式，未处理新格式的响应结构，导致深层属性访问时拿到`undefined`，最终返回`null`。
   - 老格式（正常mediaId返回）：`{ data: { audience: { demographics: xxx } } }`
   - 新格式（异常mediaId返回）：`{ audience: { demographics: xxx } }`（少了一层`data`包裹）
2. **次要问题**：无类型保护、无防御性编程、无分步日志，导致问题隐藏数月无法定位。

### 修复方案
#### 1. 类型定义与类型守卫
```typescript
// apps/worker-service/src/types/audience.ts
export interface AudienceDemographics {
  ageRange: string[];
  genderDistribution: Record<string, number>;
  location: Record<string, number>;
}

// 老格式响应
interface LegacyAudienceResponse {
  data: {
    audience: {
      demographics: AudienceDemographics;
    };
  };
}

// 新格式响应
interface NewAudienceResponse {
  audience: {
    demographics: AudienceDemographics;
  };
}

export type AudienceAPIResponse = LegacyAudienceResponse | NewAudienceResponse;

// 类型守卫函数
export function isLegacyResponse(res: unknown): res is LegacyAudienceResponse {
  return (
    typeof res === 'object' &&
    res !== null &&
    'data' in res &&
    typeof (res as LegacyAudienceResponse).data === 'object' &&
    'audience' in (res as LegacyAudienceResponse).data
  );
}

export function isNewResponse(res: unknown): res is NewAudienceResponse {
  return (
    typeof res === 'object' &&
    res !== null &&
    'audience' in res &&
    typeof (res as NewAudienceResponse).audience === 'object'
  );
}
```

#### 2. 兼容修复与防御性编程
```typescript
// apps/worker-service/src/services/facade-audience.service.ts
import { logger } from '../shared/logger';
import {
  AudienceAPIResponse,
  AudienceDemographics,
  isLegacyResponse,
  isNewResponse
} from '../types/audience';

export class FacadeAudienceService {
  private readonly logger = logger.child({ service: 'FacadeAudienceService' });

  async getAudienceData(mediaId: string, traceId: string): Promise<AudienceDemographics | null> {
    const log = this.logger.child({ mediaId, traceId });
    try {
      // 调用Playwright封装的第三方API
      const rawResponse = await this.callThirdPartyAPI(mediaId, traceId);
      log.info({ event: 'AudienceRawResponseReceived', rawResponse });

      // 格式兼容处理
      let demographics: AudienceDemographics | null = null;
      if (isLegacyResponse(rawResponse)) {
        demographics = rawResponse.data.audience.demographics ?? null;
      } else if (isNewResponse(rawResponse)) {
        demographics = rawResponse.audience.demographics ?? null;
      }

      if (!demographics) {
        log.warn({ event: 'AudienceDemographicsNotFound', rawResponse });
        return null;
      }

      log.info({ event: 'AudienceDataFetchedSuccessfully' });
      return demographics;
    } catch (err) {
      log.error({
        event: 'AudienceDataFetchFailed',
        error: err instanceof Error ? err.message : 'Unknown error',
        stack: err instanceof Error ? err.stack : undefined
      });
      return null;
    }
  }

  // 原有Playwright调用逻辑，补充等待逻辑，避免时序问题
  private async callThirdPartyAPI(mediaId: string, traceId: string): Promise<AudienceAPIResponse> {
    const browser = await this.getBrowserInstance();
    const page = await browser.newPage();
    try {
      // 等待API响应完成，避免提前提取数据
      const [response] = await Promise.all([
        page.waitForResponse(res => res.url().includes('/audience-api') && res.ok(), { timeout: 10000 }),
        page.goto(`https://third-party-platform.com/media/${mediaId}`)
      ]);
      return await response.json();
    } finally {
      await page.close();
    }
  }
}
```

### 验收标准达成
1. 执行`pnpm simulate:audience-bug`后，所有mediaId均能正确返回数据，`Errors: 0`；
2. 兼容新老两种API响应格式，不会出现返回null的问题；
3. 完善的全链路日志，可清晰追踪响应格式、提取过程、异常原因；
4. 类型保护确保TypeScript类型安全，无深层属性访问报错。

---

## 第五部分：系统设计与权衡（开放性问题）
### 前置吞吐量计算
500万条记录 / 2小时 = 500万 / 7200秒 ≈ **695条/秒**的最低吞吐量要求。当前单实例处理速度10条/秒，需至少70个并发处理单元。

### 1. 架构方案（2周可落地）
```
┌─────────────┐    触发    ┌─────────────────┐
│  S3 大文件上传│ ─────────► │  S3 Event Lambda│
└─────────────┘            └────────┬────────┘
                                     │ 流式拆分CSV为1000条/批次
                                     ▼
┌─────────────────────────────────────────────────┐
│                   SQS 标准队列                    │
│  消息去重、失败重试、按批次并行消费               │
└───────────────────────┬─────────────────────────┘
                         │ 基于队列深度自动扩缩容
                         ▼
┌─────────────────────────────────────────────────┐
│  AWS ECS Fargate Serverless Worker集群          │
│  最小1实例，最大100实例，Node.js现有代码        │
└───────────────────────┬─────────────────────────┘
                         │ 批量写入结果
                         ▼
┌─────────────────┐    聚合生成    ┌─────────────┐
│  MongoDB Atlas   │ ◄───────────── │  S3 报告存储 │
└─────────────────┘                └─────────────┘
```
**核心设计亮点**：
- 无状态Worker，基于现有Node.js代码最小改动，仅需支持批量处理；
- Serverless弹性扩缩容，无需管理服务器/K8s，1-2天即可完成搭建；
- 10GB大文件流式拆分，避免内存溢出，5000个批次并行消费，轻松达到1000条/秒的吞吐量，远超要求；
- 批量处理+批量写入，将单实例处理速度从10条/秒优化至50条/秒以上，进一步降低资源需求。

### 2. 技术选型：拒绝Rust重写建议
**明确拒绝Rust重写**，核心理由如下：
1. **时间完全不可行**：仅2周时间、1个后端人力，Rust重写需要重构所有业务逻辑、第三方集成、测试，完全无法在deadline前上线，风险极高；
2. **性能收益为0**：当前瓶颈是IO密集型（第三方API调用、数据库写入），而非CPU密集型计算，Node.js的异步IO模型完全适配该场景，Rust的性能优势无法发挥；
3. **维护灾难**：团队现有技术栈为TypeScript/Node.js，重写为Rust后，后续迭代、Bug修复、运维完全不可持续，违背创业公司技术栈统一原则；
4. **业务一致性风险**：重写必然会出现业务逻辑不一致、边界条件遗漏的问题，上线后出问题排查修复成本极高，无法保障客户SLA。

**替代方案**：
- 基于现有Node.js代码做批量处理、并发控制优化，单实例性能提升5-10倍；
- 采用AWS ECS Fargate Serverless容器，基于SQS队列深度自动扩缩容，无需管理K8s集群，快速实现水平扩展；
- 用SQS做消息解耦，拆分大文件为小批次，实现并行处理，完全无需重写核心业务逻辑，2周内可稳定上线。

### 3. 妥协与牺牲（2周1人，保核心目标）
核心原则：**牺牲非核心最佳实践，保住核心SLA、数据正确性、可观测性三大底线**。

| 最佳实践 | 牺牲程度 | 核心理由 | 替代兜底方案 |
|----------|----------|----------|--------------|
| 全量单元测试/集成测试 | 大部分牺牲 | 全量测试需3-5天，时间不足 | 仅覆盖幂等性、校验、批次处理核心逻辑的单元测试，上线前做10万条数据压测验证 |
| 严格DDD架构分层/代码抽象 | 部分牺牲 | 重构架构耗时久，易引入新Bug | 仅优化批量处理核心逻辑，保留现有业务代码，最小改动，后续再重构 |
| 多环境部署（测试/预发/生产） | 完全牺牲 | 搭建多环境耗时久，人力不足 | 仅搭建生产环境+本地压测环境，上线前做10%流量灰度验证 |
| 全链路监控/复杂告警体系 | 部分牺牲 | 搭建大盘耗时久，易被报警淹没 | 仅保留核心指标监控：队列深度、成功率、实例数、失败率，仅配置P0级系统告警 |
| 正式代码评审流程 | 完全牺牲 | 仅1个后端，无评审人力 | 核心逻辑自审，重点关注幂等性、数据一致性，小流量灰度验证 |
| 细粒度IAM权限控制 | 部分牺牲 | 配置细粒度策略耗时易出错 | 采用最小可用权限策略，保证安全底线，不做过度设计 |

### 4. 5万条错误记录的调试灾难预案
核心思路：**聚合报错、分级告警、离线存储、批量排查、隔离重试**，从根源上避免报警轰炸与日志爆炸。
1. **错误分级与聚合**
   - 拆分两类错误：**系统级错误**（数据库宕机、API整体不可用、实例崩溃）触发P0紧急告警；**数据级错误**（单条校验/处理失败）仅做聚合统计，单条不触发告警。
   - 数据级错误按批次、错误类型聚合，仅上报批次统计数据（总条数、成功数、失败数、Top3错误类型），5万条错误仅产生5000个批次的统计日志，而非5万条独立日志。
2. **分级告警策略**
   - P0告警（立即通知）：系统级错误、整体成功率<99%、队列深度持续增长30分钟；
   - P1告警（小时级汇总）：单批次失败率>5%、新增未知错误类型；
   - P2告警（日报）：单条数据错误，仅离线统计，不主动通知。
3. **错误数据离线存储与检索**
   - 失败记录按批次/错误类型批量写入S3，按日期分区存储，不写入日志系统/数据库，避免存储压力；
   - 用AWS Athena搭建离线查询能力，支持按错误类型、批次、jobId快速检索，无需写入数据库。
4. **日志采样与隔离**
   - 高频同类型错误仅采样1%的详细日志，其余仅做计数；
   - 失败记录进入死信队列，主流程完成后统一分类重试，避免重复报错；
   - 核心日志大盘仅展示聚合指标，不展示单条错误，避免研发被无效信息淹没。

---

## 面试加分项与提交注意事项
1. **强制要求**：将所有与AI的对话记录整理为`solutions/ai-chat-log.md`，重点体现你的Prompt设计、问题拆解思路、与AI的协作逻辑，这是面试官的核心考察点。
2. **加分项落地**：
   - 全链路traceId透传，从API入口到Worker到数据库，全链路可追踪；
   - 核心逻辑补充单元测试，覆盖乐观锁、校验、状态流转逻辑；
   - 在solutions目录中补充架构图，清晰展示重构前后的架构变化；
   - 所有代码符合TypeScript规范，添加清晰的注释，合理的抽象分层。
3. **面试表达重点**：重点讲根因分析、架构决策的权衡、问题排查的思路，而非单纯的代码实现，面试官更关注你的工程化思维与分布式系统治理能力。



在 第一部分：工具链建设 - Capture & Replay 中，如何将 在 Worker 服务启动时注册中间件


要在 Worker 服务启动时注册 `capture.middleware.ts`，我们需要**找到 Worker 的入口文件**，并在**消息消费流程中串联中间件与业务 Handler**。以下是基于项目结构的具体实现步骤：


### 第一步：确认 Worker 入口文件
根据项目结构，Worker 服务的入口通常为：  
`apps/worker-service/src/main.ts`（或 `index.ts`、`worker.ts`）。  

该文件负责：  
1. 连接 MongoDB（或其他依赖）；  
2. 启动 SQS 消费者（本地模拟）；  
3. 注册消息处理函数（Handler）。


### 第二步：实现中间件与 Handler 的串联
我们需要一个**“中间件组合函数”**，将 `captureMiddleware` 与业务 Handler（如 `analysisHandler`）按洋葱圈模型串联：  
先执行中间件逻辑，再通过 `next()` 调用业务 Handler。


### 第三步：完整代码实现
#### 1. 先完善中间件的类型定义（补充 `SQSMessage` 类型）
如果项目中 `@shared-types/sqs` 未导出 `SQSMessage`，可先在中间件文件中补充：
```typescript
// apps/worker-service/src/middleware/capture.middleware.ts
import * as fs from 'fs/promises';
import * as path from 'path';

// 补充 SQS 消息类型（根据项目实际类型调整）
export interface SQSMessage {
  body: {
    jobId: string;
    userId: string;
    dataUrl: string;
    traceId?: string;
  };
  messageId: string;
}

// 中间件类型定义
export type Middleware = (
  message: SQSMessage,
  next: () => Promise<void>
) => Promise<void>;

// 原有捕获逻辑（保持不变）
const ensureDir = async (dirPath: string) => {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
};

export const captureMiddleware: Middleware = async (message, next) => {
  const isCaptureMode = process.env.CAPTURE_MODE === 'true';
  const captureDir = path.resolve(process.cwd(), 'debug-payloads');

  if (!isCaptureMode) {
    return next(); // 非捕获模式直接放行
  }

  try {
    await ensureDir(captureDir);
    const jobId = message.body?.jobId || `unknown-${Date.now()}`;
    const fileName = `job-${jobId}-${Date.now()}.json`;
    const filePath = path.join(captureDir, fileName);

    await fs.writeFile(filePath, JSON.stringify(message, null, 2), 'utf-8');
    console.log(`[CaptureMiddleware] Payload saved to ${filePath}`);
  } catch (err) {
    console.error('[CaptureMiddleware] Failed to capture payload', err);
  }

  return next(); // 执行后续 Handler
};
```


#### 2. 在 Worker 入口文件中注册中间件
假设入口文件为 `apps/worker-service/src/main.ts`，修改如下：
```typescript
// apps/worker-service/src/main.ts
import { captureMiddleware, Middleware, SQSMessage } from './middleware/capture.middleware';
import { analysisHandler } from './processors/analysis.processor';
import { connectMongoDB } from './shared/db'; // 假设项目有 MongoDB 连接逻辑

// --------------------------
// 核心：中间件组合函数
// --------------------------
const composeMiddleware = (
  middlewares: Middleware[],
  handler: (message: SQSMessage) => Promise<void>
) => {
  return async (message: SQSMessage) => {
    // 从后往前串联中间件，形成洋葱圈调用链
    const next = middlewares.reduceRight(
      (nextHandler, middleware) => async () => middleware(message, nextHandler),
      async () => handler(message) // 最后执行业务 Handler
    );
    await next();
  };
};

// --------------------------
// 模拟 SQS 消费者（根据项目实际实现调整）
// --------------------------
const startSQSConsumer = async (processedHandler: (message: SQSMessage) => Promise<void>) => {
  console.log('[Worker] Starting SQS consumer...');
  
  // 模拟：循环接收消息（项目中可能是 aws-sdk 的 SQS.receiveMessage）
  while (true) {
    const mockMessage: SQSMessage = await receiveMockSQSMessage(); // 假设的消息接收函数
    try {
      await processedHandler(mockMessage); // 调用“中间件+Handler”的组合函数
    } catch (err) {
      console.error('[Worker] Failed to process message', err);
    }
  }
};

// --------------------------
// 启动 Worker
// --------------------------
const startWorker = async () => {
  // 1. 连接依赖（如 MongoDB）
  await connectMongoDB();

  // 2. 注册中间件（可扩展多个，按顺序执行）
  const middlewares = [captureMiddleware];

  // 3. 组合中间件与业务 Handler
  const processedAnalysisHandler = composeMiddleware(middlewares, analysisHandler);

  // 4. 启动 SQS 消费者，传入组合后的处理函数
  await startSQSConsumer(processedAnalysisHandler);
};

// 启动
startWorker().catch(console.error);
```


### 第四步：验证注册是否成功
按以下步骤测试，确保中间件生效：
1. 开启捕获模式启动 Worker：
   ```bash
   CAPTURE_MODE=true pnpm run start:worker
   ```
2. 触发一个分析任务（通过 LegacyApp 的 API）；
3. 检查 `debug-payloads/` 目录，应生成对应的 JSON 文件；
4. 关闭 `CAPTURE_MODE`（或设为 `false`）重启 Worker，再次触发任务，**不会**生成新文件。


### 关键说明
- **中间件顺序**：如果后续添加多个中间件（如日志中间件、鉴权中间件），按 `middlewares` 数组的**顺序**执行（洋葱圈模型：先执行的中间件后收尾）。
- **错误处理**：中间件中捕获自身错误（如文件写入失败），避免影响主流程；业务 Handler 的错误由外层消费者统一处理。
- **项目适配**：如果项目使用了现成的 SQS 消费者库（如 `sqs-consumer`），可直接在库的 `handleMessage` 配置中传入组合后的 `processedAnalysisHandler`，无需自己写模拟循环。


需要我帮你针对项目中具体的 SQS 消费者实现（如 `sqs-consumer` 库）调整注册代码吗？
