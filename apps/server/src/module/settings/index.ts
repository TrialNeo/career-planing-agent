import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
const configuration = z.object({
  baseUrl: z
    .url()
    .max(2000)
    .refine((value) => {
      const u = new URL(value);
      return (
        ['http:', 'https:'].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash
      );
    }, '仅支持不带凭证的 HTTP 地址'),
  model: z.string().trim().max(300),
  apiKey: z.string().trim().max(8000).optional(),
});
type Credentials = z.infer<typeof configuration>;
// This configuration belongs to the server. It has no user-facing read or write API.
export class Settings {
  private readonly config: Credentials;
  constructor(path?: string) {
    if (!path || !existsSync(path)) {
      this.config = { baseUrl: 'https://api.openai.com/v1', model: '' };
      return;
    }
    try {
      const parsed = configuration.parse(JSON.parse(readFileSync(path, 'utf8')));
      this.config = { ...parsed, baseUrl: parsed.baseUrl.replace(/\/+$/, '') };
    } catch {
      // JSON and validation errors can include configuration values, including secrets.
      throw new Error(
        '模型配置文件无效，请检查 model.json 的 JSON 格式、baseUrl、model 和 apiKey 字段。',
      );
    }
  }
  credentials() {
    return { ...this.config };
  }
  configured() {
    return !!(this.config.model && this.config.apiKey);
  }
}
