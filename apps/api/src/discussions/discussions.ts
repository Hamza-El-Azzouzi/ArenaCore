import {Body, Controller, Delete, Get, Inject, Injectable, Param, Post, Put, Query, Req, Res, UseGuards} from '@nestjs/common';
import {CreateDiscussion, createDiscussionReplySchema, createDiscussionSchema, DiscussionLikeState, DiscussionPost, discussionQuerySchema, uuidSchema} from '@arenacore/contracts';
import {Prisma} from '@prisma/client';
import {Response} from 'express';
import {z} from 'zod';
import {AuthenticatedRequest, SessionGuard} from '../auth/session';
import {ApiError, validate} from '../common/errors';
import {Database} from '../database/database';

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
const postSelect = {
  id: true, title: true, body: true, createdAt: true, updatedAt: true,
  author: {select: {username: true, displayName: true}},
  _count: {select: {replies: {where: {status: 'VISIBLE' as const}}, likes: true}},
} satisfies Prisma.DiscussionPostSelect;
type SelectedPost = Prisma.DiscussionPostGetPayload<{select: typeof postSelect}>;
type LimitRow = {count: number};

const project = (row: SelectedPost): DiscussionPost => ({
  id: row.id, author: row.author, ...(row.title ? {title: row.title} : {}), body: row.body,
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  replyCount: row._count.replies, likeCount: row._count.likes,
});

@Injectable()
export class Discussions {
  constructor(@Inject(Database) private readonly db: Database) {}

  private async publishedProblem(slug: string) {
    const problem = await this.db.problem.findUnique({where: {slug}, select: {id: true, currentVersion: {select: {published: true}}}});
    if (!problem?.currentVersion?.published) throw new ApiError(404, 'NOT_FOUND', 'Problem not found.');
    return problem.id;
  }

  private async consumeWriteQuota(tx: Prisma.TransactionClient, userId: string) {
    const rows = await tx.$queryRaw<LimitRow[]>`INSERT INTO "DiscussionRateLimit" ("userId", count, "expiresAt")
      VALUES (${userId}::uuid, 1, CURRENT_TIMESTAMP + interval '1 minute')
      ON CONFLICT ("userId") DO UPDATE SET
        count = CASE WHEN "DiscussionRateLimit"."expiresAt" <= CURRENT_TIMESTAMP THEN 1 ELSE "DiscussionRateLimit".count + 1 END,
        "expiresAt" = CASE WHEN "DiscussionRateLimit"."expiresAt" <= CURRENT_TIMESTAMP THEN CURRENT_TIMESTAMP + interval '1 minute' ELSE "DiscussionRateLimit"."expiresAt" END
      RETURNING count`;
    if ((rows[0]?.count ?? 11) > 10) throw new ApiError(429, 'DISCUSSION_RATE_LIMITED', 'Too many discussion posts. Try again shortly.', 60);
  }

  async list(slug: string, cursor?: string) {
    const problemId = await this.publishedProblem(slug);
    if (cursor) {
      const boundary = await this.db.discussionPost.findFirst({where: {id: cursor, problemId, parentId: null, status: 'VISIBLE'}, select: {id: true}});
      if (!boundary) throw new ApiError(400, 'INVALID_CURSOR', 'Discussion cursor is invalid.');
    }
    const rows = await this.db.discussionPost.findMany({
      where: {problemId, parentId: null, status: 'VISIBLE'}, select: postSelect,
      orderBy: [{createdAt: 'desc'}, {id: 'desc'}], ...(cursor ? {cursor: {id: cursor}, skip: 1} : {}), take: 21,
    });
    return {items: rows.slice(0, 20).map(project), nextCursor: rows.length > 20 ? rows[19]!.id : null};
  }

  async replies(postId: string, cursor?: string) {
    const parent = await this.db.discussionPost.findFirst({where: {id: postId, parentId: null, status: 'VISIBLE', problem: {currentVersion: {is: {published: true}}}}, select: {id: true}});
    if (!parent) throw new ApiError(404, 'NOT_FOUND', 'Discussion not found.');
    if (cursor) {
      const boundary = await this.db.discussionPost.findFirst({where: {id: cursor, parentId: postId, status: 'VISIBLE'}, select: {id: true}});
      if (!boundary) throw new ApiError(400, 'INVALID_CURSOR', 'Reply cursor is invalid.');
    }
    const rows = await this.db.discussionPost.findMany({where: {parentId: postId, status: 'VISIBLE'}, select: postSelect, orderBy: [{createdAt: 'asc'}, {id: 'asc'}], ...(cursor ? {cursor: {id: cursor}, skip: 1} : {}), take: 21});
    return {items: rows.slice(0, 20).map(project), nextCursor: rows.length > 20 ? rows[19]!.id : null};
  }

  async create(slug: string, userId: string, input: CreateDiscussion) {
    const problemId = await this.publishedProblem(slug);
    const row = await this.db.$transaction(async tx => {
      await this.consumeWriteQuota(tx, userId);
      const created = await tx.discussionPost.create({data: {problemId, authorId: userId, title: input.title, body: input.body}, select: postSelect});
      await tx.auditEvent.create({data: {actorId: userId, action: 'DISCUSSION_CREATE', targetId: created.id}});
      return created;
    });
    return project(row);
  }

  async reply(postId: string, userId: string, body: string) {
    const parent = await this.db.discussionPost.findFirst({where: {id: postId, parentId: null, status: 'VISIBLE', problem: {currentVersion: {is: {published: true}}}}, select: {id: true, problemId: true}});
    if (!parent) throw new ApiError(404, 'NOT_FOUND', 'Discussion not found.');
    const row = await this.db.$transaction(async tx => {
      await this.consumeWriteQuota(tx, userId);
      const created = await tx.discussionPost.create({data: {problemId: parent.problemId, parentId: parent.id, authorId: userId, body}, select: postSelect});
      await tx.auditEvent.create({data: {actorId: userId, action: 'DISCUSSION_REPLY_CREATE', targetId: created.id}});
      return created;
    });
    return project(row);
  }

  async like(postId: string, userId: string, liked: boolean): Promise<DiscussionLikeState> {
    const post = await this.db.discussionPost.findFirst({where: {id: postId, status: 'VISIBLE', problem: {currentVersion: {is: {published: true}}}}, select: {id: true}});
    if (!post) throw new ApiError(404, 'NOT_FOUND', 'Discussion not found.');
    const likeCount = await this.db.$transaction(async tx => {
      if (liked) await tx.discussionLike.upsert({where: {postId_userId: {postId, userId}}, create: {postId, userId}, update: {}});
      else await tx.discussionLike.deleteMany({where: {postId, userId}});
      return tx.discussionLike.count({where: {postId}});
    });
    return {postId, liked, likeCount};
  }
}

@Controller()
export class DiscussionsController {
  constructor(@Inject(Discussions) private readonly discussions: Discussions) {}

  @Get('problems/:slug/discussions')
  list(@Param('slug') slug: string, @Query() query: unknown, @Res({passthrough: true}) res: Response) { res.setHeader('Cache-Control', 'public, max-age=15'); return this.discussions.list(validate(slugSchema, slug), validate(discussionQuerySchema, query).cursor); }

  @Post('problems/:slug/discussions')
  @UseGuards(SessionGuard)
  create(@Param('slug') slug: string, @Req() req: AuthenticatedRequest, @Body() body: unknown, @Res({passthrough: true}) res: Response) { res.setHeader('Cache-Control', 'no-store'); return this.discussions.create(validate(slugSchema, slug), req.principal.userId, validate(createDiscussionSchema, body)); }

  @Get('discussions/:id/replies')
  replies(@Param('id') id: string, @Query() query: unknown, @Res({passthrough: true}) res: Response) { res.setHeader('Cache-Control', 'public, max-age=15'); return this.discussions.replies(validate(uuidSchema, id), validate(discussionQuerySchema, query).cursor); }

  @Post('discussions/:id/replies')
  @UseGuards(SessionGuard)
  reply(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Body() body: unknown, @Res({passthrough: true}) res: Response) { res.setHeader('Cache-Control', 'no-store'); return this.discussions.reply(validate(uuidSchema, id), req.principal.userId, validate(createDiscussionReplySchema, body).body); }

  @Put('discussions/:id/like')
  @UseGuards(SessionGuard)
  like(@Param('id') id: string, @Req() req: AuthenticatedRequest) { return this.discussions.like(validate(uuidSchema, id), req.principal.userId, true); }

  @Delete('discussions/:id/like')
  @UseGuards(SessionGuard)
  unlike(@Param('id') id: string, @Req() req: AuthenticatedRequest) { return this.discussions.like(validate(uuidSchema, id), req.principal.userId, false); }
}
