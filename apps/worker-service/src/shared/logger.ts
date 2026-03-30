import pino from 'pino';
import type { LogContext } from '@senior-challenge/shared-types';

// 配置结构化日志
const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development' ? {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss Z' }
  } : undefined,
  base: {}, // 不添加默认字段
  formatters: {
    level: (label) => ({ level: label })
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

// 创建带上下文的子日志（强制包含 traceId）
export const createTracedLogger = (context: LogContext) => {
  return baseLogger.child(context);
};

// 导出基础日志（用于系统级日志）
export const logger = baseLogger;
