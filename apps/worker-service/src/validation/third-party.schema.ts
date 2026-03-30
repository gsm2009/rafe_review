import { z } from 'zod';

// 年龄字段兼容处理：数字、数字字符串、带+号的字符串、null
const AgeSchema = z.union([
  z.number(),
  z.string().regex(/^\d+\+?$/).transform(val => parseInt(val.replace('+', ''), 10)),
  z.null().transform(() => 0)
]).default(0);

// 性别字段：枚举或null
const GenderSchema = z.union([
  z.enum(['male', 'female', 'other']),
  z.string().transform(val => val.toLowerCase() as 'male' | 'female' | 'other'),
  z.null().transform(() => 'unknown')
]).default('unknown');

// 标签字段：数组或逗号分隔字符串或null
const TagsSchema = z.union([
  z.array(z.string()),
  z.string().transform(val => val.split(',').map(s => s.trim()).filter(Boolean)),
  z.null().transform(() => [])
]).default([]);

// 置信度字段：数字或数字字符串或null
const ScoreSchema = z.union([
  z.number(),
  z.string().transform(val => parseFloat(val)),
  z.null().transform(() => 0)
]).default(0);

// 第三方 API 响应完整 Schema
export const ThirdPartyApiResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    age: AgeSchema,
    gender: GenderSchema,
    country: z.string().nullable().default('unknown'),
    city: z.string().nullable().optional(),
    tags: TagsSchema,
    score: ScoreSchema
  }).nullable().optional()
});

// 导出类型
export type ValidatedThirdPartyResponse = z.infer<typeof ThirdPartyApiResponseSchema>;
