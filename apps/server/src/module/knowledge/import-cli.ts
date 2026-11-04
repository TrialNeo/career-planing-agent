import { resolve } from 'node:path';
import { openDatabase } from '../../platform/database/index.js';
import { Knowledge } from './index.js';

const workbook = resolve(process.argv[2] ?? 'knowledge/岗位能力需求统计表(1)(1).xlsx');
const database = resolve(process.argv[3] ?? '.local/career.sqlite');
const db = openDatabase(database);
try {
  const result = new Knowledge(db).importWorkbook(workbook);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  db.close();
}
