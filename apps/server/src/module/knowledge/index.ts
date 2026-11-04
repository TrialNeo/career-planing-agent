import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import type { SourceRef } from '../../../../../packages/contracts/src/index.js';
import type { Db } from '../../platform/database/index.js';

export const knowledgeKinds = ['jobs', 'skills', 'directions', 'paths', 'courses'] as const;
export type KnowledgeKind = typeof knowledgeKinds[number];
export type KnowledgeItem = {
  id: string;
  kind: KnowledgeKind;
  label: string;
  sources: SourceRef[];
  [field: string]: unknown;
};
export type KnowledgeSearchInput = {
  kinds: KnowledgeKind[];
  query?: string;
  direction?: string;
  education?: string;
  experience?: string;
  limit?: number;
};
export type KnowledgeSearchResult = {
  items: KnowledgeItem[];
  sources: SourceRef[];
  datasetVersion: string | null;
  limitations: string[];
};
type Statistics = {
  jobs: number;
  javaCount: number;
  backendCount: number;
  javaCoverage: number;
  backendShare: number;
};
type Dataset = { datasetVersion: string; items: KnowledgeItem[]; stats: Statistics };
type Cell = string | number | boolean | null;
const limitations = [
  '岗位样本来自静态工作簿，可能过时，不代表最新招聘市场或全部岗位。',
  '原始岗位没有逐条采集时间和链接；collectedAt 与 url 保留为 null，来源代号不等于已验证招聘页面。',
  '课程为培养方案参考课程及建议修读学年，不是学习者的个人课表、已修记录或当前开课安排。',
  '能力覆盖率与方向占比以岗位明细重新计算；不采用原统计表中错误的比例和合计。',
];
const text = (value: unknown) => value == null ? '' : String(value).trim();
const includes = (value: unknown, query?: string) => !query || text(value).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
const tags = (value: unknown) => [...new Set(text(value).split('、').map(part => part.trim()).filter(Boolean))];
const uniqueSources = (sources: SourceRef[]) => [...new Map(sources.map(source => [JSON.stringify(source), source])).values()];

export class Knowledge {
  constructor(private readonly db: Db) {}

  importWorkbook(path: string) {
    const bytes = readFileSync(path);
    const datasetVersion = createHash('sha256').update(bytes).digest('hex');
    const existing = this.db.get<Dataset>('knowledge_record', datasetVersion);
    if (existing) {
      this.db.transaction(() => this.db.put('knowledge_metadata', 'active', { datasetVersion }));
      return this.importResult(existing);
    }
    const workbook = XLSX.read(bytes, { type: 'buffer' });
    const sheet = (prefix: string, headerRow: number, expected: string[]) => {
      const name = workbook.SheetNames.find(candidate => candidate.startsWith(prefix));
      if (!name) throw new Error(`Missing knowledge sheet: ${prefix}`);
      const rows = XLSX.utils.sheet_to_json<Cell[]>(workbook.Sheets[name], { header: 1, defval: null, blankrows: true });
      if (expected.some((header, column) => text(rows[headerRow - 1]?.[column]) !== header)) {
        throw new Error(`Unexpected knowledge sheet header: ${name}:${headerRow}`);
      }
      return { name, rows };
    };
    const jobsSheet = sheet('①', 1, ['序号', '公司', '岗位', '学历']);
    const skillsSheet = sheet('②', 1, ['排名', '能力标签', '命中条数']);
    const directionName = workbook.SheetNames.find(name => name.startsWith('③'));
    if (!directionName) throw new Error('Missing knowledge sheet: ③');
    const directionRows = XLSX.utils.sheet_to_json<Cell[]>(workbook.Sheets[directionName], { header: 1, defval: null, blankrows: true });
    const pathsSheet = sheet('④', 1, ['序号', '公司', '岗位', '方向']);
    const coursesSheet = sheet('⑤', 4, ['模块', '课程号', '课程名称（中/英）', '学分']);
    const source = (name: string, row: number, sourceValue: unknown = null): SourceRef => ({
      datasetVersion, sheet: name, row, source: text(sourceValue) || null, url: null, collectedAt: null,
    });
    const item = (kind: KnowledgeKind, row: number, label: string, sources: SourceRef[], fields: Record<string, unknown>): KnowledgeItem => ({
      id: `${datasetVersion}:${kind}:${row}`, kind, label, ...fields, sources,
    });
    const jobs: KnowledgeItem[] = [];
    jobsSheet.rows.forEach((row, index) => {
      if (index === 0 || !text(row[1]) || !text(row[2])) return;
      if (!Number.isInteger(Number(row[0])) || !text(row[13])) throw new Error(`Invalid job detail row: ${index + 1}`);
      jobs.push(item('jobs', index + 1, `${text(row[1])} · ${text(row[2])}`, [source(jobsSheet.name, index + 1, row[10])], {
        sequence: Number(row[0]), company: text(row[1]), job: text(row[2]), title: text(row[2]), education: text(row[3]),
        salary: text(row[4]), city: text(row[5]), experience: text(row[6]), directionCategory: text(row[7]),
        industry: text(row[8]), rawSkills: text(row[9]), requiredSkills: tags(row[11]), bonusSkills: tags(row[12]),
        direction: text(row[13]), skills: tags(row[14]),
      }));
    });
    if (jobs.length === 0) throw new Error('Knowledge workbook contains no job details');
    const jobByPair = new Map(jobs.map(job => [JSON.stringify([job.company, job.job]), job]));
    const skills: KnowledgeItem[] = [];
    skillsSheet.rows.forEach((row, index) => {
      const label = text(row[1]);
      if (index === 0 || !label) return;
      const matching = jobs.filter(job => (job.skills as string[]).includes(label));
      if (!matching.length) return;
      skills.push(item('skills', index + 1, label, uniqueSources([source(skillsSheet.name, index + 1), ...matching.flatMap(job => job.sources)]), {
        count: matching.length, denominator: jobs.length, coverage: matching.length / jobs.length,
        category: text(row[4]), definition: text(row[5]), countBasis: 'job_detail_rows',
      }));
    });
    // Include detail tags even if a future workbook omits their summary row.
    for (const label of new Set(jobs.flatMap(job => job.skills as string[]))) {
      if (skills.some(skill => skill.label === label)) continue;
      const matching = jobs.filter(job => (job.skills as string[]).includes(label));
      skills.push(item('skills', skillsSheet.rows.length + skills.length, label, matching.flatMap(job => job.sources), {
        count: matching.length, denominator: jobs.length, coverage: matching.length / jobs.length, countBasis: 'job_detail_rows',
      }));
    }
    const directions: KnowledgeItem[] = [];
    for (const label of new Set(jobs.map(job => text(job.direction)))) {
      const matching = jobs.filter(job => job.direction === label);
      const index = directionRows.findIndex(row => text(row[0]) === label);
      directions.push(item('directions', index >= 0 ? index + 1 : directions.length + 1, label,
        uniqueSources([...(index >= 0 ? [source(directionName, index + 1)] : []), ...matching.flatMap(job => job.sources)]), {
          direction: label, count: matching.length, denominator: jobs.length, coverage: matching.length / jobs.length,
          note: index >= 0 ? text(directionRows[index][3]) : '', countBasis: 'job_detail_rows',
        }));
    }
    const paths: KnowledgeItem[] = [];
    pathsSheet.rows.forEach((row, index) => {
      if (index === 0 || !text(row[0]) || !text(row[1])) return;
      // The source's visible headers are shifted; validate the actual row against JD details.
      const job = jobByPair.get(JSON.stringify([text(row[0]), text(row[1])]));
      if (!job || job.education !== text(row[2]) || job.direction !== text(row[3]) || text(row[7])) {
        throw new Error(`Unexpected shifted learning-path mapping at row ${index + 1}`);
      }
      paths.push(item('paths', index + 1, `${text(row[0])} · ${text(row[1])}`, [source(pathsSheet.name, index + 1), ...job.sources], {
        company: text(row[0]), job: text(row[1]), education: text(row[2]), direction: text(row[3]), experience: job.experience,
        bonusMaterial: text(row[4]), requiredCoursePath: text(row[5]), project: text(row[6]),
      }));
    });
    const courses: KnowledgeItem[] = [];
    let module = '';
    coursesSheet.rows.forEach((row, index) => {
      if (index < 4) return;
      if (text(row[0])) module = text(row[0]);
      // Six-digit course IDs distinguish real courses from later credit-check summary rows.
      if (!/^\d{6}$/.test(text(row[1])) || !text(row[2])) return;
      courses.push(item('courses', index + 1, text(row[2]), [source(coursesSheet.name, index + 1)], {
        code: text(row[1]), name: text(row[2]), credits: typeof row[3] === 'number' ? row[3] : null,
        module, suggestedAcademicYear: text(row[4]), semester: text(row[5]), nature: text(row[6]),
        category: text(row[7]), capabilities: text(row[8]), referenceOnly: true,
      }));
    });
    const javaCount = jobs.filter(job => (job.skills as string[]).includes('Java工具链')).length;
    const backendCount = jobs.filter(job => job.direction === '后端开发方向').length;
    const dataset: Dataset = {
      datasetVersion, items: [...jobs, ...skills, ...directions, ...paths, ...courses],
      stats: { jobs: jobs.length, javaCount, backendCount, javaCoverage: javaCount / jobs.length, backendShare: backendCount / jobs.length },
    };
    this.db.transaction(() => {
      this.db.put('knowledge_record', datasetVersion, dataset);
      this.db.put('knowledge_metadata', 'active', { datasetVersion });
    });
    return this.importResult(dataset);
  }

  search(input: KnowledgeSearchInput): KnowledgeSearchResult {
    if (!input || !Array.isArray(input.kinds) || input.kinds.some(kind => !knowledgeKinds.includes(kind))) {
      throw new Error('kinds must be an array of jobs, skills, directions, paths, courses');
    }
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer between 1 and 200');
    for (const key of ['query', 'direction', 'education', 'experience'] as const) {
      if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error(`${key} must be a string`);
    }
    const dataset = this.activeDataset();
    if (!dataset) return { items: [], sources: [], datasetVersion: null, limitations: ['尚未导入知识工作簿。', ...limitations] };
    const structuredMatch = (record: KnowledgeItem) => includes(record.direction, input.direction) && includes(record.education, input.education) && includes(record.experience, input.experience);
    const filteredJobs = dataset.items.filter(record => record.kind === 'jobs' && structuredMatch(record));
    const jobRows = new Set(filteredJobs.flatMap(job => job.sources.map(ref => ref.row)));
    const hasStructuredFilter = Boolean(input.direction?.trim() || input.education?.trim() || input.experience?.trim());
    let records = dataset.items.filter(record => input.kinds.includes(record.kind));
    if (hasStructuredFilter) {
      records = records.flatMap(record => {
        if (record.kind === 'jobs' || record.kind === 'paths') return structuredMatch(record) ? [record] : [];
        if (record.kind === 'courses') {
          // A curriculum has no learner education/experience fields; never imply such a match.
          if (input.education?.trim() || input.experience?.trim()) return [];
          const direction = input.direction?.replace(/开发方向$|方向$/g, '');
          return includes(record.capabilities, direction) ? [record] : [];
        }
        const matching = record.sources.filter(ref => ref.sheet.startsWith('①') && jobRows.has(ref.row));
        if (!matching.length) return [];
        return [{ ...record, count: matching.length, denominator: filteredJobs.length, coverage: matching.length / filteredJobs.length,
          sources: uniqueSources([...record.sources.filter(ref => !ref.sheet.startsWith('①')), ...matching]), countBasis: 'filtered_job_detail_rows' }];
      });
    }
    const terms = input.query?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
    records = records.filter(record => {
      const { sources: _sources, id: _id, ...fields } = record;
      const haystack = JSON.stringify(fields).toLocaleLowerCase();
      return terms.every(term => haystack.includes(term));
    }).slice(0, limit);
    return { items: records, sources: uniqueSources(records.flatMap(record => record.sources)), datasetVersion: dataset.datasetVersion, limitations: [...limitations] };
  }

  stats(): Statistics {
    return this.activeDataset()?.stats ?? { jobs: 0, javaCount: 0, backendCount: 0, javaCoverage: 0, backendShare: 0 };
  }

  private activeDataset() {
    const metadata = this.db.get<{ datasetVersion: string }>('knowledge_metadata', 'active');
    return metadata ? this.db.get<Dataset>('knowledge_record', metadata.datasetVersion) : undefined;
  }

  private importResult(dataset: Dataset) {
    return { datasetVersion: dataset.datasetVersion, ...dataset.stats,
      skills: dataset.items.filter(item => item.kind === 'skills').length,
      directions: dataset.items.filter(item => item.kind === 'directions').length,
      paths: dataset.items.filter(item => item.kind === 'paths').length,
      courses: dataset.items.filter(item => item.kind === 'courses').length };
  }
}
