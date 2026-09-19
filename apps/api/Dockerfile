ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

WORKDIR /opt/arenacore

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/runner/package.json apps/runner/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/judge/package.json packages/judge/package.json
COPY packages/runtime-policy/package.json packages/runtime-policy/package.json
RUN npm ci

COPY apps ./apps
COPY packages ./packages
COPY prisma ./prisma
COPY runtime-images ./runtime-images
RUN npm run db:generate \
    && npm run build \
    && npm prune --omit=dev

ENV NODE_ENV=production
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
