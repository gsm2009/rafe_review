# Part 2: 架构治理 - Single Source of Truth 根因分析

## 1. 问题复现前提
查看两个核心文件：
- `apps/legacy-app/src/analysis/analysis.service.ts`（NestJS API层）
- `apps/worker-service/src/processors/analysis.processor.ts`（异步处理层）

## 2. Bug 现象
用户反馈“刚刚看到的分析结果，刷新后又变了”，数据出现“闪烁”。

## 3. 根因定位（完全基于原始代码）

### 3.1 职责边界严重混乱
- **LegacyApp（API层）**：既负责接收请求、创建任务，又执行 `calculateQuickDemographics` 随机计算，并写入数据库
- **WorkerService（异步处理层）**：也执行完整的真实计算，并写入同一条记录的 `demographics` 字段
- 两个服务无明确的读写权限划分，违背单一职责原则

### 3.2 故意设计的致命竞态触发点
原始代码中存在 **`setTimeout(() => this.delayedUpdate(...), 2000)`**，2秒后无条件覆盖数据库中的 `demographics` 字段：
1. LegacyApp 创建任务 → 写入随机的 `quickDemographics` → 发送消息给Worker
2. Worker 接收消息 → 执行真实计算 → 若在2秒内完成，写入正确的结果
3. 2秒后，LegacyApp 的 `delayedUpdate` 触发 → **无条件覆盖** Worker 的正确结果
4. 用户刷新页面时，先看到Worker的正确结果，再刷新看到LegacyApp的旧结果，视觉上就是“数据闪烁”

### 3.3 无状态流转与并发控制
- 无严格的任务状态机（PENDING → PROCESSING → COMPLETED）
- 原类型中 `version` 是可选字段，未被强制使用
- 所有数据库更新都是无条件的，无任何乐观锁/悲观锁保障

## 4. 解决方案概述
1. **职责拆分**：LegacyApp 只负责任务分发（创建 PENDING 状态任务、发送 SQS 消息），彻底删除 `calculateQuickDemographics` 和 `delayedUpdate`
2. **强制使用乐观锁**：将 `version` 改为必选字段，创建任务时设为 0
3. **Worker 成为唯一真相来源**：所有计算和结果写入都在 Worker 中完成
4. **严格状态流转**：PENDING → PROCESSING → COMPLETED 单向流转
