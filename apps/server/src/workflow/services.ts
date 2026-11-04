import type { Db } from '../platform/database/index.js';
import type { Conversation } from '../module/conversation/index.js';
import type { Learner } from '../module/learner/index.js';
import type { Planning } from '../module/planning/index.js';
import type { Learning } from '../module/learning/index.js';
import type { Knowledge } from '../module/knowledge/index.js';
import type { Settings } from '../module/settings/index.js';
export type Services = {
  db: Db;
  conversation: Conversation;
  learner: Learner;
  planning: Planning;
  learning: Learning;
  knowledge: Knowledge;
  settings: Settings;
};
