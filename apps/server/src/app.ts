import { resolve, dirname, join } from 'node:path';
import { openDatabase } from './platform/database/index.js';
import { PiRunner, type AgentRunner } from './platform/agent/index.js';
import { Conversation } from './module/conversation/index.js';
import { Learner } from './module/learner/index.js';
import { Planning } from './module/planning/index.js';
import { Learning } from './module/learning/index.js';
import { Knowledge } from './module/knowledge/index.js';
import { Settings } from './module/settings/index.js';
import { Auth } from './module/auth/index.js';
import { createHttpApp } from './http/index.js';
import { Dialogue } from './workflow/dialogue/index.js';
export type AppOptions = {
  databasePath?: string;
  settingsPath?: string;
  runner?: AgentRunner;
  importKnowledge?: boolean;
  workbookPath?: string;
  webDirectory?: string;
};
export function createApp(options: AppOptions = {}) {
  const databasePath = options.databasePath ?? resolve('.local/career.sqlite');
  const db = openDatabase(databasePath);
  const conversation = new Conversation(db);
  const learner = new Learner(db);
  const planning = new Planning(db);
  const learning = new Learning(db);
  const knowledge = new Knowledge(db);
  const settings = new Settings(
    options.settingsPath ??
      (databasePath === ':memory:' ? undefined : join(dirname(databasePath), 'model.json')),
  );
  const services = { db, conversation, learner, planning, learning, knowledge, settings };
  const runner = options.runner ?? new PiRunner();
  const dialogue = new Dialogue(services, runner);
  const legacyWorkspace = { ...services, dialogue };
  const auth = new Auth(db);
  const workspaces = new Map<string, typeof legacyWorkspace>();
  function forUser(userId: string) {
    auth.getUser(userId);
    if (auth.isLegacyOwner(userId)) return legacyWorkspace;
    const existing = workspaces.get(userId);
    if (existing) return existing;
    // Generated user IDs select the storage directory; no client path or identity is accepted.
    const folder = join(dirname(databasePath), 'users', userId);
    const userDb = openDatabase(
      databasePath === ':memory:' ? ':memory:' : join(folder, 'career.sqlite'),
    );
    const userServices = {
      db: userDb,
      conversation: new Conversation(userDb),
      learner: new Learner(userDb),
      planning: new Planning(userDb),
      learning: new Learning(userDb),
      knowledge,
      settings,
    };
    const workspace = { ...userServices, dialogue: new Dialogue(userServices, runner) };
    workspace.conversation.recover();
    workspaces.set(userId, workspace);
    return workspace;
  }
  conversation.recover();
  for (const user of auth.users()) forUser(user.id);
  if (options.importKnowledge !== false)
    knowledge.importWorkbook(
      options.workbookPath ?? resolve('knowledge/岗位能力需求统计表(1)(1).xlsx'),
    );
  const app = createHttpApp({ auth, forUser }, { webDirectory: options.webDirectory });
  return {
    app,
    ...services,
    dialogue,
    auth,
    forUser,
    async close() {
      await Promise.all([
        dialogue.close(),
        ...[...workspaces.values()].map((w) => w.dialogue.close()),
      ]);
      for (const workspace of workspaces.values()) workspace.db.close();
      db.close();
    },
  };
}
export type Application = ReturnType<typeof createApp>;
