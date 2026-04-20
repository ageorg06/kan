FROM node:20-alpine
WORKDIR /app

RUN npm install -g tsx

# Install deps first (before any workspace package.json is copied)
RUN npm init -y --silent && npm install @modelcontextprotocol/sdk zod pg

# Copy source the MCP server reads at runtime
COPY packages/mcp/src/ packages/mcp/src/
COPY packages/mcp/tsconfig.json packages/mcp/
COPY packages/db/src/schema/ packages/db/src/schema/
COPY packages/db/src/repository/ packages/db/src/repository/
COPY packages/api/src/routers/ packages/api/src/routers/
COPY pnpm-workspace.yaml .

# Copy package.json files for get_package_map tool (read-only, not installed)
COPY apps/web/package.json apps/web/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/stripe/package.json packages/stripe/package.json
COPY tooling/eslint/package.json tooling/eslint/package.json
COPY tooling/prettier/package.json tooling/prettier/package.json
COPY tooling/tailwind/package.json tooling/tailwind/package.json
COPY tooling/typescript/package.json tooling/typescript/package.json

ENV NODE_ENV=production
ENV MCP_PORT=3100
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://localhost:3100/health || exit 1

CMD ["tsx", "packages/mcp/src/index.ts"]
