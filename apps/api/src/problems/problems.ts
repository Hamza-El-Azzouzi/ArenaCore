import { Controller, Get, Inject, Injectable, Param, Query } from '@nestjs/common';
import { languageSchema, ProblemDetail, ProblemSummary, problemQuerySchema } from '@arenacore/contracts';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Database } from '../database/database';
import { ApiError, validate } from '../common/errors';

// Explicit projection: no query for private test fields in public endpoints.
const publicVersionSelect = {
  title: true, difficulty: true, tags: true, statementMarkdown: true, constraints: true,
  timeMs: true, memoryKiB: true, templates: true, inputMode: true,
  testCases: {where: {visibility: 'PUBLIC' as const}, orderBy: {ordinal: 'asc' as const}, select: {id: true, input: true, expectedOutput: true, files:{orderBy:{name:'asc' as const},select:{name:true,content:true}}}},
} satisfies Prisma.ProblemVersionSelect;
const templatesSchema = z.record(languageSchema, z.string());

@Injectable()
export class Problems {
  constructor(@Inject(Database) private readonly db: Database) {}
  async list(query: z.infer<typeof problemQuerySchema>) {
    const rows = await this.db.problem.findMany({
      where: {currentVersion: {is: {published: true, ...(query.difficulty ? {difficulty: query.difficulty} : {}), ...(query.search ? {OR: [{title: {contains: query.search, mode: 'insensitive' as const}}, {tags: {has: query.search.toLowerCase()}}]} : {})}}, ...(query.cursor ? {id: {gt: query.cursor}} : {})},
      select: {id: true, slug: true, currentVersion: {select: {title: true, difficulty: true, tags: true}}},
      orderBy: {id: 'asc'}, take: 21,
    });
    const items: ProblemSummary[] = rows.slice(0, 20).map(row => ({id: row.id, slug: row.slug, ...row.currentVersion!}));
    return {items, nextCursor: rows.length > 20 ? items.at(-1)!.id : null};
  }
  async detail(slug: string): Promise<ProblemDetail> {
    const row = await this.db.problem.findUnique({where: {slug}, select: {id: true, slug: true, currentVersion: {select: {...publicVersionSelect, published: true}}}});
    if (!row?.currentVersion?.published) throw new ApiError(404, 'NOT_FOUND', 'Problem not found.');
    const v = row.currentVersion;
    return {id: row.id, slug: row.slug, title: v.title, difficulty: v.difficulty, tags: v.tags, statementMarkdown: v.statementMarkdown, constraints: v.constraints, limits: {timeMs: v.timeMs, memoryKiB: v.memoryKiB}, inputMode:v.inputMode, examples: v.testCases.map(t => ({id: t.id, input: t.input, files:t.files, expectedOutput: t.expectedOutput})), templates: templatesSchema.parse(v.templates)};
  }
}
@Controller('problems')
export class ProblemsController {
  constructor(@Inject(Problems) private readonly problems: Problems) {}
  @Get() list(@Query() query: unknown) { return this.problems.list(validate(problemQuerySchema, query)); }
  @Get(':slug') detail(@Param('slug') slug: string) {
    validate(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100), slug);
    return this.problems.detail(slug);
  }
}
