import { resolve } from 'node:path';
import { Settings } from '../apps/server/src/module/settings/index.js';
import { PiRunner } from '../apps/server/src/platform/agent/index.js';
import { testModel } from '../apps/server/src/workflow/dialogue/test-model.js';
const settings = new Settings(resolve('.local/model.json'));
if (!settings.configured()) {
  console.error(
    '未配置真实 Responses 服务。请填写服务端 .local/model.json 后重新执行 npm run test:live。',
  );
  process.exitCode = 2;
} else {
  const result = await testModel(new PiRunner(), settings);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
