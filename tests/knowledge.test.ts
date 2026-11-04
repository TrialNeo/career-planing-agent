import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, type Db } from '../apps/server/src/platform/database/index.js';
import { Knowledge } from '../apps/server/src/module/knowledge/index.js';

const workbook = resolve('knowledge/岗位能力需求统计表(1)(1).xlsx');
let db: Db;
let temporaryDirectory: string | undefined;
afterEach(() => {
  db?.close();
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});
function imported() {
  db = openDatabase(':memory:');
  const knowledge = new Knowledge(db);
  const result = knowledge.importWorkbook(workbook);
  return { knowledge, result };
}

describe('source grounded career knowledge', () => {
  it('recalculates corrected coverage from 115 detail rows and imports idempotently', () => {
    const { knowledge, result } = imported();
    const datasetVersion = createHash('sha256').update(readFileSync(workbook)).digest('hex');
    expect(result.datasetVersion).toBe(datasetVersion);
    expect(knowledge.stats()).toMatchObject({ jobs: 115, javaCount: 71, backendCount: 61 });
    expect(knowledge.stats().javaCoverage).toBeCloseTo(71 / 115);
    expect(knowledge.stats().backendShare).toBeCloseTo(61 / 115);
    expect(knowledge.importWorkbook(workbook)).toEqual(result);
    expect(knowledge.search({ kinds: ['jobs'], limit: 200 }).items).toHaveLength(115);
    const java = knowledge.search({ kinds: ['skills'], query: 'Java' }).items[0];
    expect(java).toMatchObject({
      kind: 'skills',
      label: 'Java工具链',
      count: 71,
      denominator: 115,
    });
    expect(java.coverage).toBeCloseTo(71 / 115);
    const backend = knowledge.search({ kinds: ['directions'], query: '后端' }).items[0];
    expect(backend).toMatchObject({ label: '后端开发方向', count: 61, denominator: 115 });
    expect(backend.coverage).toBeCloseTo(61 / 115);
  });

  it('keeps exact workbook row provenance and does not invent source URLs or collection dates', () => {
    const { knowledge, result } = imported();
    const found = knowledge.search({ kinds: ['jobs'], query: '上海从鲸信息' });
    expect(found.datasetVersion).toBe(result.datasetVersion);
    expect(found.items).toHaveLength(1);
    expect(found.sources).toEqual([
      {
        datasetVersion: result.datasetVersion,
        sheet: '①去重JD库·115条',
        row: 2,
        source: 'B1',
        url: null,
        collectedAt: null,
      },
    ]);
    expect(found.items[0].sources).toEqual(found.sources);
    expect(found.limitations.join(' ')).toMatch(/采集时间/);
    expect(found.limitations.join(' ')).toMatch(/时效|最新/);
  });

  it('maps shifted learning path rows by their actual values', () => {
    const { knowledge } = imported();
    const path = knowledge.search({ kinds: ['paths'], query: '上海从鲸信息' }).items[0];
    expect(path).toMatchObject({
      company: '上海从鲸信息',
      job: 'Java后端开发',
      education: '本科',
      direction: '后端开发方向',
    });
    expect(path.bonusMaterial).toContain('分布式与微服务进阶');
    expect(path.requiredCoursePath).toContain('Java程序设计');
    expect(path.project).toContain('Spring Boot 电商/秒杀单体');
    expect(path.sources[0]).toMatchObject({ sheet: '④学习路径与毕业项目', row: 2, source: null });
    expect(path.experience).toBe('1-3年');
    expect(path.sources).toContainEqual(
      expect.objectContaining({ sheet: '①去重JD库·115条', row: 2, source: 'B1' }),
    );
  });

  it('imports actual curriculum course rows and excludes headings and numeric credit checks', () => {
    const { knowledge } = imported();
    const courses = knowledge.search({ kinds: ['courses'], limit: 200 });
    expect(courses.items.length).toBeGreaterThan(90);
    expect(
      courses.items.every(
        (course) => /^\d{6}$/.test(String(course.code)) && course.referenceOnly === true,
      ),
    ).toBe(true);
    const first = knowledge.search({ kinds: ['courses'], query: '604487' }).items[0];
    expect(first).toMatchObject({
      name: '大学英语 I / College English I',
      suggestedAcademicYear: '2025-2026',
      semester: '1',
      referenceOnly: true,
    });
    expect(first.sources[0]).toMatchObject({ sheet: '⑤培养方案课程表', row: 7, source: null });
    expect(courses.limitations.join(' ')).toMatch(/培养方案/);
    expect(courses.limitations.join(' ')).toMatch(/个人课表/);
  });

  it('combines structured filters and bounds results while retaining matching source rows', () => {
    const { knowledge } = imported();
    const found = knowledge.search({
      kinds: ['jobs', 'paths'],
      query: 'Java',
      direction: '后端',
      education: '本科',
      experience: '1-3年',
      limit: 3,
    });
    expect(found.items.length).toBeGreaterThan(0);
    expect(found.items.length).toBeLessThanOrEqual(3);
    expect(
      found.items.every(
        (item) =>
          ['jobs', 'paths'].includes(item.kind) &&
          String(item.direction).includes('后端') &&
          String(item.education).includes('本科'),
      ),
    ).toBe(true);
    expect(
      found.sources.every(
        (source) => source.row >= 2 && source.url === null && source.collectedAt === null,
      ),
    ).toBe(true);
    expect(() => knowledge.search({ kinds: ['invalid'] as never })).toThrow();
    expect(() => knowledge.search({ kinds: ['jobs'], limit: 0 })).toThrow();
  });

  it('reports no dataset before import and survives failed import without replacing active data', () => {
    db = openDatabase(':memory:');
    const knowledge = new Knowledge(db);
    expect(knowledge.stats().jobs).toBe(0);
    expect(knowledge.search({ kinds: ['jobs'] })).toMatchObject({
      items: [],
      sources: [],
      datasetVersion: null,
    });
    const original = knowledge.importWorkbook(workbook);
    expect(() => knowledge.importWorkbook('knowledge/absent.xlsx')).toThrow();
    expect(knowledge.search({ kinds: ['jobs'] }).datasetVersion).toBe(original.datasetVersion);
  });

  it('persists the imported dataset across database reopen and keeps the source workbook byte-identical', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'career-knowledge-'));
    const databasePath = join(temporaryDirectory, 'knowledge.sqlite');
    const before = readFileSync(workbook);
    db = openDatabase(databasePath);
    const result = new Knowledge(db).importWorkbook(workbook);
    db.close();
    db = openDatabase(databasePath);
    const reopened = new Knowledge(db);
    expect(reopened.stats().jobs).toBe(115);
    expect(reopened.search({ kinds: ['jobs'] }).datasetVersion).toBe(result.datasetVersion);
    expect(readFileSync(workbook)).toEqual(before);
    const invalid = join(temporaryDirectory, 'invalid.xlsx');
    writeFileSync(invalid, 'not a career knowledge workbook');
    expect(() => reopened.importWorkbook(invalid)).toThrow(/sheet/);
    expect(reopened.search({ kinds: ['jobs'] }).datasetVersion).toBe(result.datasetVersion);
  });

  it('recomputes aggregate denominators within structured filters and cites contributing job rows', () => {
    const { knowledge } = imported();
    const selectedJobs = knowledge.search({ kinds: ['jobs'], direction: '后端', limit: 200 }).items;
    const expected = selectedJobs.filter((job) => (job.skills as string[]).includes('Java工具链'));
    const java = knowledge.search({ kinds: ['skills'], query: 'Java', direction: '后端' }).items[0];
    expect(java).toMatchObject({
      count: expected.length,
      denominator: 61,
      countBasis: 'filtered_job_detail_rows',
    });
    expect(java.coverage).toBeCloseTo(expected.length / 61);
    expect(java.sources.filter((ref) => ref.sheet.startsWith('①')).map((ref) => ref.row)).toEqual(
      expected.map((job) => job.sources[0].row),
    );
    expect(knowledge.search({ kinds: ['courses'], education: '本科' }).items).toHaveLength(0);
  });
});
