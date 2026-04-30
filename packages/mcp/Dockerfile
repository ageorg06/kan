# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=20

# ============================================
# Stage 1: Alpine base with pnpm and turbo
# ============================================
FROM node:${NODE_VERSION}-alpine AS alpine
RUN apk update && \
    apk add --no-cache libc6-compat && \
    rm -rf /var/cache/apk/* /tmp/* || true && \
    corepack enable && \
    npm install turbo@2.3.1 --global && \
    pnpm config set store-dir ~/.pnpm-store

# ============================================
# Stage 2: Prune the monorepo to @kan/mcp + deps
# ============================================
FROM alpine AS pruner
WORKDIR /app
COPY . .
RUN turbo prune --scope=@kan/mcp --docker

# ============================================
# Stage 3: Install dependencies on the pruned tree
# ============================================
FROM alpine AS deps
WORKDIR /app

COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=pruner /app/out/json/ .

ENV CI=true
RUN pnpm install --frozen-lockfile

# ============================================
# Stage 4: Runtime image with full source
# ============================================
FROM alpine AS runtime
WORKDIR /app

COPY --from=deps /app/ ./
COPY --from=pruner /app/out/full/ .

ENV NODE_ENV=production
ENV MCP_PORT=3100
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://localhost:3100/health || exit 1

CMD ["pnpm", "-F", "@kan/mcp", "start"]
