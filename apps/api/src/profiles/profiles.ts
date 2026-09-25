import {Body, Controller, Get, Inject, Injectable, Param, Patch, Query, Req, Res, UseGuards} from '@nestjs/common';
import {ContributionDay, leaderboardQuerySchema, LeaderboardEntry, ProfileDifficultyStat, ProfileLanguageStat, PublicProfile, SubmissionSummary, UpdateProfile, updateProfileSchema, usernameSchema} from '@arenacore/contracts';
import {Prisma} from '@prisma/client';
import {Response} from 'express';
import {Database} from '../database/database';
import {ApiError, validate} from '../common/errors';
import {AuthenticatedRequest, SessionGuard} from '../auth/session';

type CountRow = {count: bigint | number};
type ContributionRow = {date: string; count: number};
type SolvedRow = {difficulty: 'EASY' | 'MEDIUM' | 'HARD'; count: number};
type LeaderRow = {id: string; username: string; displayName: string; problemsSolved: bigint | number; acceptedSubmissions: bigint | number; totalSubmissions: bigint | number; rank: bigint | number};
const count = (value: bigint | number | null | undefined) => Number(value ?? 0);

function streaks(contributions: ContributionDay[]) {
  const days = [...new Set(contributions.filter(day => day.count > 0).map(day => day.date))].sort();
  let longest = 0;
  let run = 0;
  let previous = '';
  for (const day of days) {
    const adjacent = previous && Date.parse(`${day}T00:00:00Z`) - Date.parse(`${previous}T00:00:00Z`) === 86_400_000;
    run = adjacent ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);
  const yesterdayKey = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1)).toISOString().slice(0, 10);
  if (previous !== todayKey && previous !== yesterdayKey) return {currentStreak: 0, longestStreak: longest};
  let current = 1;
  for (let index = days.length - 1; index > 0; index--) {
    if (Date.parse(`${days[index]}T00:00:00Z`) - Date.parse(`${days[index - 1]}T00:00:00Z`) !== 86_400_000) break;
    current++;
  }
  return {currentStreak: current, longestStreak: longest};
}

@Injectable()
export class Profiles {
  constructor(@Inject(Database) private readonly db: Database) {}

  async publicProfile(username: string): Promise<PublicProfile> {
    const user = await this.db.user.findUnique({where: {username}, select: {id: true, username: true, displayName: true, bio: true, location: true, website: true, createdAt: true}});
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'Profile not found.');
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 364);
    since.setUTCHours(0, 0, 0, 0);
    const [totalSubmissions, acceptedSubmissions, solvedRows, runtime, contributions, languageTotals, languageAccepted, availableDifficulties, solvedDifficulties, recentRows] = await Promise.all([
      this.db.execution.count({where: {userId: user.id, mode: 'SUBMIT'}}),
      this.db.execution.count({where: {userId: user.id, mode: 'SUBMIT', verdict: 'ACCEPTED'}}),
      this.db.$queryRaw<CountRow[]>`SELECT count(DISTINCT pv."problemId")::int AS count FROM "Execution" e JOIN "ProblemVersion" pv ON pv.id=e."problemVersionId" WHERE e."userId"=${user.id}::uuid AND e.mode='SUBMIT' AND e.verdict='ACCEPTED'`,
      this.db.execution.aggregate({where: {userId: user.id, mode: 'SUBMIT', runtimeMs: {not: null}}, _avg: {runtimeMs: true}}),
      this.db.$queryRaw<ContributionRow[]>`SELECT to_char(date_trunc('day', "createdAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date, count(*)::int AS count FROM "Execution" WHERE "userId"=${user.id}::uuid AND mode='SUBMIT' AND "createdAt">=${since} GROUP BY 1 ORDER BY 1`,
      this.db.execution.groupBy({by: ['language'], where: {userId: user.id, mode: 'SUBMIT'}, _count: {_all: true}}),
      this.db.execution.groupBy({by: ['language'], where: {userId: user.id, mode: 'SUBMIT', verdict: 'ACCEPTED'}, _count: {_all: true}}),
      this.db.problemVersion.groupBy({by: ['difficulty'], where: {published: true, currentFor: {isNot: null}}, _count: {_all: true}}),
      this.db.$queryRaw<SolvedRow[]>`SELECT current."difficulty" AS difficulty, count(DISTINCT p.id)::int AS count FROM "Execution" e JOIN "ProblemVersion" attempted ON attempted.id=e."problemVersionId" JOIN "Problem" p ON p.id=attempted."problemId" JOIN "ProblemVersion" current ON current.id=p."currentVersionId" WHERE e."userId"=${user.id}::uuid AND e.mode='SUBMIT' AND e.verdict='ACCEPTED' AND current.published GROUP BY current."difficulty"`,
      this.db.execution.findMany({where: {userId: user.id, mode: 'SUBMIT'}, select: {id: true, language: true, state: true, verdict: true, createdAt: true, runtimeMs: true, memoryKiB: true, failureCode: true, problemVersion: {select: {problemId: true, title: true}}}, orderBy: [{createdAt: 'desc'}, {id: 'desc'}], take: 10}),
    ]);
    const acceptedByLanguage = new Map(languageAccepted.map(row => [row.language, row._count._all]));
    const languages: ProfileLanguageStat[] = languageTotals.map(row => ({language: row.language, submissions: row._count._all, accepted: acceptedByLanguage.get(row.language) ?? 0}));
    const solvedByDifficulty = new Map(solvedDifficulties.map(row => [row.difficulty, count(row.count)]));
    const totalsByDifficulty = new Map(availableDifficulties.map(row => [row.difficulty, row._count._all]));
    const difficulties: ProfileDifficultyStat[] = (['EASY', 'MEDIUM', 'HARD'] as const).map(difficulty => ({difficulty, solved: solvedByDifficulty.get(difficulty) ?? 0, total: totalsByDifficulty.get(difficulty) ?? 0}));
    const recentSubmissions: SubmissionSummary[] = recentRows.map(row => ({executionId: row.id, problemId: row.problemVersion.problemId, problemTitle: row.problemVersion.title, language: row.language, state: row.state, createdAt: row.createdAt.toISOString(), ...(row.verdict ? {verdict: row.verdict} : {}), ...(row.runtimeMs !== null ? {runtimeMs: row.runtimeMs} : {}), ...(row.memoryKiB !== null ? {memoryKiB: row.memoryKiB} : {}), ...(row.failureCode ? {failureCode: row.failureCode} : {})}));
    const streak = streaks(contributions);
    return {
      username: user.username, displayName: user.displayName, joinedAt: user.createdAt.toISOString(),
      ...(user.bio ? {bio: user.bio} : {}), ...(user.location ? {location: user.location} : {}), ...(user.website ? {website: user.website} : {}),
      stats: {totalSubmissions, acceptedSubmissions, successRate: totalSubmissions ? Math.round(acceptedSubmissions * 100 / totalSubmissions) : 0, problemsSolved: count(solvedRows[0]?.count), ...streak, ...(runtime._avg.runtimeMs !== null ? {averageRuntimeMs: Math.round(runtime._avg.runtimeMs)} : {})},
      contributions, languages, difficulties, recentSubmissions,
    };
  }

  async self(userId: string) {
    const user = await this.db.user.findUnique({where: {id: userId}, select: {username: true}});
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'Profile not found.');
    return this.publicProfile(user.username);
  }

  async update(userId: string, input: UpdateProfile) {
    const data = {
      ...(input.username !== undefined ? {username: input.username} : {}),
      ...(input.displayName !== undefined ? {displayName: input.displayName} : {}),
      ...(input.bio !== undefined ? {bio: input.bio || null} : {}),
      ...(input.location !== undefined ? {location: input.location || null} : {}),
      ...(input.website !== undefined ? {website: input.website || null} : {}),
    };
    try {
      const user = await this.db.$transaction(async tx => {
        const updated = await tx.user.update({where: {id: userId}, data, select: {username: true}});
        await tx.auditEvent.create({data: {actorId: userId, action: 'PROFILE_UPDATE', targetId: userId}});
        return updated;
      });
      return this.publicProfile(user.username);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ApiError(409, 'USERNAME_TAKEN', 'That username is already in use.');
      throw error;
    }
  }

  async leaderboard(cursor?: string) {
    if (cursor) {
      const active = await this.db.execution.findFirst({where: {userId: cursor, mode: 'SUBMIT'}, select: {id: true}});
      if (!active) throw new ApiError(400, 'INVALID_CURSOR', 'Leaderboard cursor is invalid.');
    }
    const cursorClause = cursor ? Prisma.sql`WHERE ranked.rank > (SELECT rank FROM ranked WHERE id=${cursor}::uuid)` : Prisma.empty;
    const rows = await this.db.$queryRaw<LeaderRow[]>(Prisma.sql`
      WITH stats AS (
        SELECT u.id, u.username, u."displayName", count(e.id)::bigint AS "totalSubmissions",
          count(e.id) FILTER (WHERE e.verdict='ACCEPTED')::bigint AS "acceptedSubmissions",
          count(DISTINCT pv."problemId") FILTER (WHERE e.verdict='ACCEPTED')::bigint AS "problemsSolved"
        FROM "User" u JOIN "Execution" e ON e."userId"=u.id AND e.mode='SUBMIT'
        JOIN "ProblemVersion" pv ON pv.id=e."problemVersionId"
        GROUP BY u.id
      ), ranked AS (
        SELECT *, row_number() OVER (ORDER BY "problemsSolved" DESC, "acceptedSubmissions" DESC, username ASC, id ASC)::bigint AS rank FROM stats
      )
      SELECT * FROM ranked ${cursorClause} ORDER BY rank ASC LIMIT 21
    `);
    const items: LeaderboardEntry[] = rows.slice(0, 20).map(row => ({rank: count(row.rank), username: row.username, displayName: row.displayName, problemsSolved: count(row.problemsSolved), acceptedSubmissions: count(row.acceptedSubmissions), totalSubmissions: count(row.totalSubmissions), successRate: count(row.totalSubmissions) ? Math.round(count(row.acceptedSubmissions) * 100 / count(row.totalSubmissions)) : 0}));
    return {items, nextCursor: rows.length > 20 ? rows[19]!.id : null};
  }
}

@Controller()
export class ProfilesController {
  constructor(@Inject(Profiles) private readonly profiles: Profiles) {}

  @Get('profiles/me')
  @UseGuards(SessionGuard)
  self(@Req() req: AuthenticatedRequest, @Res({passthrough: true}) res: Response) { res.setHeader('Cache-Control', 'no-store'); return this.profiles.self(req.principal.userId); }

  @Patch('profiles/me')
  @UseGuards(SessionGuard)
  update(@Req() req: AuthenticatedRequest, @Body() body: unknown, @Res({passthrough: true}) res: Response) { res.setHeader('Cache-Control', 'no-store'); return this.profiles.update(req.principal.userId, validate(updateProfileSchema, body)); }

  @Get('profiles/:username')
  profile(@Param('username') username: string, @Res({passthrough: true}) res: Response) { res.setHeader('Cache-Control', 'public, max-age=60'); return this.profiles.publicProfile(validate(usernameSchema, username)); }

  @Get('leaderboard')
  leaderboard(@Query() query: unknown, @Res({passthrough: true}) res: Response) { res.setHeader('Cache-Control', 'public, max-age=30'); const parsed = validate(leaderboardQuerySchema, query); return this.profiles.leaderboard(parsed.cursor); }
}
