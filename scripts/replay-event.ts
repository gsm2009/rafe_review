// scripts/replay-event.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { AnalysisProcessor } from '../apps/worker-service/src/processors/analysis.processor';
import type { AnalysisRequestedEvent } from '@senior-challenge/shared-types';

// ==============================================
// 核心修复：手动解析 process.argv，不依赖 minimist
// ==============================================
const getFileArg = (): string | null => {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // 匹配 --file=xxx 或 --file xxx 两种格式
    if (arg.startsWith('--file=')) {
      return arg.replace('--file=', '');
    }
    if (arg === '--file' && argv[i + 1]) {
      return argv[i + 1];
    }
  }
  return null;
};

const fileInput = getFileArg();

// 检查参数
if (!fileInput) {
  console.error('❌ 错误：请指定 Payload 文件');
  console.error('使用方法：pnpm run replay -- --file=debug-payloads/job-xxx.json');
  process.exit(1);
}

const runReplay = async () => {
  console.log('=====================================');
  console.log('🎬 开始重放任务');
  console.log('=====================================');

  try {
    let absolutePath: string;

    // 路径映射逻辑
    if (fileInput.startsWith('debug-payloads/')) {
      const fileName = fileInput.replace('debug-payloads/', '');
      absolutePath = path.resolve(process.cwd(), 'apps/worker-service/debug-payloads', fileName);
      console.log(`📍 自动映射到: apps/worker-service/debug-payloads/`);
    } else if (path.isAbsolute(fileInput)) {
      absolutePath = fileInput;
    } else {
      absolutePath = path.resolve(process.cwd(), fileInput);
    }
    
    console.log(`📂 读取文件: ${absolutePath}`);

    // 检查文件是否存在
    try {
      await fs.access(absolutePath);
    } catch {
      console.error(`❌ 文件不存在: ${absolutePath}`);
      // 列出目录下的文件供参考
      try {
        const defaultDir = path.resolve(process.cwd(), 'apps/worker-service/debug-payloads');
        const files = await fs.readdir(defaultDir);
        if (files.length > 0) {
          console.log(`💡 提示：${defaultDir} 目录下有以下文件：`);
          files.slice(0, 5).forEach(f => console.log(`   - ${f}`));
          if (files.length > 5) console.log(`   ... 还有 ${files.length - 5} 个文件`);
        }
      } catch {}
      process.exit(1);
    }

    // 读取并解析 Payload
    const fileContent = await fs.readFile(absolutePath, 'utf-8');
    const event: AnalysisRequestedEvent = JSON.parse(fileContent);
    
    console.log(`✅ 解析成功，Job ID: ${event.jobId}`);
    console.log('=====================================');

    // 初始化 Processor
    console.log('🔌 初始化数据库连接...');
    const processor = new AnalysisProcessor();

    // 直接调用 Handler
    console.log('🚀 执行任务处理逻辑...');
    console.log('-------------------------------------');
    await processor.process(event);
    console.log('-------------------------------------');

    console.log('=====================================');
    console.log('✅ 重放完成！');
    console.log('=====================================');
    process.exit(0);
  } catch (error) {
    console.error('=====================================');
    console.error('❌ 重放失败：');
    console.error(error);
    console.error('=====================================');
    process.exit(1);
  }
};

runReplay();
