# syntax=docker/dockerfile:1
###############################################################################
# RoadGuard Atlas — Frontend (Next.js 16, standalone output)
#
# Build context = repository root:
#   docker build -f infrastructure/docker/frontend.Dockerfile -t rg-frontend .
#   docker run -p 3000:3000 -e NEXT_PUBLIC_API_BASE_URL=http://localhost:8000 rg-frontend
#
# BUN OPTION: the repo commits bun.lock, so you can swap both build stages for
#   `oven/bun:1-alpine` and replace the npm install/build lines with:
#     RUN bun install --frozen-lockfile
#     RUN bun run build
# The npm path below is kept as the default because it works everywhere
# (npm ci when a package-lock.json is present, npm install otherwise).
#
# NOTE: next.config.ts already sets `output: "standalone"`; the repo build
# script additionally copies .next/static and public/ into .next/standalone —
# the runner stage below copies all three defensively, so it works either way.
###############################################################################

# ---- deps: install node_modules + generate Prisma client --------------------
FROM node:20-alpine AS deps
WORKDIR /app
# libc6-compat: glibc shims required by sharp/native deps on musl (alpine)
RUN apk add --no-cache libc6-compat
COPY package.json bun.lock* package-lock.json* ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
    else npm install --no-audit --no-fund; fi \
 && npx prisma generate

# ---- build: compile the standalone production bundle ------------------------
FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `npm run build` = `next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/`
RUN npm run build

# ---- runner: minimal non-root runtime ---------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -q -O- http://127.0.0.1:3000/ >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
