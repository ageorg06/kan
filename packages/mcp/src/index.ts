#!/usr/bin/env node

/**
 * Kan MCP Server
 *
 * Exposes Kan's codebase structure to AI coding agents via Model Context Protocol.
 * Tools: get_schema, get_routes, get_package_map, get_conventions
 *
 * Modes:
 *   Local (stdio):  npx tsx packages/mcp/src/index.ts
 *   Cloud (HTTP):   MCP_PORT=3100 npx tsx packages/mcp/src/index.ts
 *
 * Environment:
 *   MCP_PORT        - Set to enable HTTP mode (e.g. 3100)
 *   MCP_AUTH_TOKEN  - Bearer token for HTTP auth (required in production)
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pg from "pg";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

function findRoot(): string {
  let dir = resolve(__dirname);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const ROOT = findRoot();
const SCHEMA_DIR = join(ROOT, "packages/db/src/schema");
const ROUTER_DIR = join(ROOT, "packages/api/src/routers");
const REPO_DIR = join(ROOT, "packages/db/src/repository");

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts",
    )
    .sort();
}

function read(filepath: string): string {
  return readFileSync(filepath, "utf-8");
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

// Extract pgTable names from a Drizzle schema file
function extractTableNames(content: string): string[] {
  return [...content.matchAll(/pgTable\(\s*["']([^"']+)["']/g)].map(
    (m) => m[1],
  );
}

// Extract pgEnum names from a Drizzle schema file
function extractEnumNames(content: string): string[] {
  return [...content.matchAll(/pgEnum\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
}

// Extract tRPC procedure declarations from a router file
function extractProcedures(
  content: string,
): Array<{ name: string; type: string; access: string }> {
  const results: Array<{ name: string; type: string; access: string }> = [];
  const procRegex =
    /(\w+)\s*:\s*(protectedProcedure|publicProcedure|adminProtectedProcedure)/g;

  let match;
  while ((match = procRegex.exec(content)) !== null) {
    const name = match[1];
    const access = match[2].replace("Procedure", "");

    // Look ahead (up to 800 chars) for .query or .mutation
    const lookahead = content.slice(match.index, match.index + 800);
    const typeMatch = lookahead.match(/\.(query|mutation)\s*\(/);
    const type = typeMatch ? typeMatch[1] : "unknown";

    results.push({ name, type, access });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Server factory — one McpServer per transport (required for HTTP mode)
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: "kan",
    version: "1.0.0",
  });
  registerTools(server);
  return server;
}

function registerTools(server: McpServer): void {
  // ---- Tool 1: get_schema -------------------------------------------------

  server.tool(
    "get_schema",
    "Get Kan database schema (Drizzle ORM). No params = compact table listing. With table name = full schema file.",
    {
      table: z
        .string()
        .optional()
        .describe(
          "Table name for detail view (e.g. 'card', 'board', 'workspace', 'list')",
        ),
    },
    async ({ table }) => {
      if (!table) {
        const files = tsFiles(SCHEMA_DIR);
        const lines: string[] = [
          "# Kan Database Schema (Drizzle ORM + PostgreSQL)\n",
        ];

        for (const file of files) {
          const content = read(join(SCHEMA_DIR, file));
          const tables = extractTableNames(content);
          const enums = extractEnumNames(content);

          if (tables.length === 0 && enums.length === 0) continue;

          lines.push(`## ${file}`);
          if (tables.length) lines.push(`  Tables: ${tables.join(", ")}`);
          if (enums.length) lines.push(`  Enums: ${enums.join(", ")}`);
          lines.push("");
        }

        lines.push("---");
        lines.push("## Key Patterns");
        lines.push(
          "- `publicId` (varchar 12, unique) on all user-facing entities. NEVER expose internal `id`.",
        );
        lines.push(
          "- `deletedAt` (timestamp) for soft delete. ALWAYS filter with `isNull(table.deletedAt)`.",
        );
        lines.push(
          "- `index` (integer) on card, list, card_checklist, card_checklist_item. Must maintain sequential ordering on move/delete using transactions.",
        );
        lines.push(
          "- `createdBy` / `createdAt` / `updatedAt` on nearly all tables.",
        );
        lines.push("- All tables use `.enableRLS()` for row-level security.");
        lines.push("");
        lines.push("## Repositories");

        const repoFiles = tsFiles(REPO_DIR);
        if (repoFiles.length) {
          for (const f of repoFiles) {
            lines.push(`  - ${f}`);
          }
        }

        lines.push(
          "\nUse get_schema with a table name (e.g. 'card', 'board') for the full definition.",
        );

        return text(lines.join("\n"));
      }

      // Detail mode: find file containing the table
      const files = tsFiles(SCHEMA_DIR);
      for (const file of files) {
        const content = read(join(SCHEMA_DIR, file));
        const tables = extractTableNames(content);
        if (tables.includes(table)) {
          return text(
            `# Schema file: ${file}\n# Tables: ${tables.join(", ")}\n\n${content}`,
          );
        }
      }

      // Try partial match (e.g. "cards" -> "card")
      for (const file of files) {
        const content = read(join(SCHEMA_DIR, file));
        const tables = extractTableNames(content);
        const found = tables.find(
          (t) =>
            t.includes(table.toLowerCase()) || table.toLowerCase().includes(t),
        );
        if (found) {
          return text(
            `# Schema file: ${file}\n# Tables: ${tables.join(", ")}\n# (matched "${found}" for query "${table}")\n\n${content}`,
          );
        }
      }

      // Try matching filename
      for (const file of files) {
        if (file.replace(".ts", "").includes(table.toLowerCase())) {
          const content = read(join(SCHEMA_DIR, file));
          return text(`# Schema file: ${file}\n\n${content}`);
        }
      }

      const allTables = files.flatMap((f) =>
        extractTableNames(read(join(SCHEMA_DIR, f))),
      );
      return text(
        `Table "${table}" not found.\n\nAvailable tables: ${allTables.join(", ")}\n\nTip: Use get_schema() without params for an overview.`,
      );
    },
  );

  // ---- Tool 2: get_routes --------------------------------------------------

  server.tool(
    "get_routes",
    "Get Kan tRPC API routes. No params = list all routers with procedures. With router name = full implementation.",
    {
      router: z
        .string()
        .optional()
        .describe(
          "Router name for detail view (e.g. 'card', 'board', 'workspace')",
        ),
    },
    async ({ router }) => {
      if (!router) {
        const files = tsFiles(ROUTER_DIR);
        const lines: string[] = ["# Kan API Routes (tRPC)\n"];

        for (const file of files) {
          const content = read(join(ROUTER_DIR, file));
          const procs = extractProcedures(content);

          lines.push(`## ${file.replace(".ts", "")}`);
          if (procs.length === 0) {
            lines.push("  (no procedures detected - may use nested routers)");
          }
          for (const p of procs) {
            lines.push(`  ${p.name}: ${p.type} (${p.access})`);
          }
          lines.push("");
        }

        lines.push("---");
        lines.push("## API Patterns");
        lines.push(
          "- protectedProcedure = authenticated, publicProcedure = public",
        );
        lines.push("- Always validate inputs with Zod schemas");
        lines.push(
          "- Always check workspace membership via assertUserInWorkspace",
        );
        lines.push("- Create card_activity records for all card mutations");
        lines.push("- Fire webhooks for card.created/updated/moved/deleted");
        lines.push(
          "- Use TRPCError with UNAUTHORIZED, NOT_FOUND, BAD_REQUEST, FORBIDDEN",
        );
        lines.push("- Add .meta() with OpenAPI info on every procedure");
        lines.push(
          "\nUse get_routes with a router name for the full implementation.",
        );

        return text(lines.join("\n"));
      }

      // Detail mode
      const filename = router.endsWith(".ts") ? router : `${router}.ts`;
      const filepath = join(ROUTER_DIR, filename);

      if (existsSync(filepath)) {
        return text(`# Router: ${router}\n\n${read(filepath)}`);
      }

      // Try partial match
      const files = tsFiles(ROUTER_DIR);
      const found = files.find((f) => f.includes(router.toLowerCase()));
      if (found) {
        return text(
          `# Router: ${found.replace(".ts", "")}\n\n${read(join(ROUTER_DIR, found))}`,
        );
      }

      return text(
        `Router "${router}" not found.\n\nAvailable: ${files.map((f) => f.replace(".ts", "")).join(", ")}\n\nTip: Use get_routes() without params for an overview.`,
      );
    },
  );

  // ---- Tool 3: get_package_map ---------------------------------------------

  server.tool(
    "get_package_map",
    "Get Kan monorepo package structure with names and internal dependencies.",
    {},
    async () => {
      const lines: string[] = ["# Kan Monorepo Package Map\n"];
      const sections = ["apps", "packages", "tooling"];

      for (const section of sections) {
        const sectionDir = join(ROOT, section);
        if (!existsSync(sectionDir)) continue;

        lines.push(`## ${section}/`);
        const dirs = readdirSync(sectionDir).sort();

        for (const dir of dirs) {
          const pkgPath = join(sectionDir, dir, "package.json");
          if (!existsSync(pkgPath)) continue;

          const pkg = JSON.parse(read(pkgPath));
          const allDeps = {
            ...(pkg.dependencies || {}),
            ...(pkg.devDependencies || {}),
          };
          const internalDeps = Object.keys(allDeps)
            .filter((d) => d.startsWith("@kan/"))
            .sort();

          lines.push(`  ### ${section}/${dir}`);
          lines.push(`  Name: ${pkg.name}`);
          if (pkg.description) lines.push(`  Description: ${pkg.description}`);
          if (internalDeps.length)
            lines.push(`  Uses: ${internalDeps.join(", ")}`);
          lines.push("");
        }
      }

      lines.push("---");
      lines.push("## Key Scripts (root package.json)");
      lines.push("  pnpm dev          - Start dev server");
      lines.push("  pnpm build        - Build all packages");
      lines.push("  pnpm lint         - Run ESLint");
      lines.push("  pnpm typecheck    - Run TypeScript checks");
      lines.push("  pnpm format:fix   - Run Prettier");
      lines.push("  pnpm db:migrate   - Run database migrations");
      lines.push("  pnpm db:studio    - Open Drizzle Studio");
      lines.push("  pnpm lingui:extract - Extract i18n strings");

      return text(lines.join("\n"));
    },
  );

  // ---- Tool 4: get_conventions ---------------------------------------------

  const CONVENTIONS: Record<string, string> = {
    "soft-delete": `# Soft Delete Pattern

- Entities use \`deletedAt\` timestamp for deletion (NOT hard delete)
- Always filter queries with \`isNull(table.deletedAt)\`
- Set \`deletedBy\` to the acting user's ID
- Tables with soft delete: board, card, card_comments, card_attachment, card_checklist, card_checklist_item, label, list, notification, workspace, workspace_members
- Exception: workspace.delete and webhook.delete are hard deletes`,

    "public-id": `# Public ID Pattern

- All user-facing entities have \`publicId\` (varchar 12, unique, randomly generated)
- NEVER expose internal database \`id\` (bigserial) in API responses, URLs, or frontend code
- Always use \`publicId\` for external communication (API params, URLs, frontend state)
- When writing new queries: select publicId, not id, for anything sent to the client`,

    "index-management": `# Index Management

- Cards, lists, checklists, checklist items all have \`index\` (integer) for ordering
- Creating: append at end (max index + 1) or insert at specific position
- Moving: adjust indices of ALL affected items in both source and target containers
- Deleting: decrement indices of items AFTER the deleted one
- ALWAYS wrap index updates in a database transaction
- Query with \`ORDER BY index ASC\` for display`,

    "activity-tracking": `# Activity Tracking

Every significant card change creates a \`card_activity\` record:
- card.created, card.archived
- card.updated.title, card.updated.description, card.updated.index, card.updated.list
- card.updated.label.added/removed, card.updated.member.added/removed
- card.updated.comment.added/updated/deleted
- card.updated.checklist.added/renamed/deleted
- card.updated.checklist.item.added/updated/completed/uncompleted/deleted
- card.updated.attachment.added/removed
- card.updated.dueDate.added/updated/removed

Activities store before/after values: fromTitle/toTitle, fromListId/toListId, fromIndex/toIndex, etc.`,

    authorization: `# Authorization

1. User must be authenticated (protectedProcedure)
2. User must have workspace access (assertUserInWorkspace helper)
3. User must have the required permission for the operation

Workspace roles: admin, member, guest
Member statuses: invited, active, removed, paused
Custom roles: workspace_roles table with hierarchyLevel
Permission overrides: workspace_member_permissions per-member overrides`,

    "api-patterns": `# API Patterns

- tRPC procedures in packages/api/src/routers/ (not REST)
- protectedProcedure for auth'd endpoints, publicProcedure for public
- Validate ALL inputs with Zod schemas
- TRPCError codes: UNAUTHORIZED, NOT_FOUND, BAD_REQUEST, FORBIDDEN
- Add .meta() with OpenAPI info for documentation
- Use optimistic updates (onMutate) on frontend
- Invalidate tRPC queries after mutations
- Fire webhooks for: card.created, card.updated, card.moved, card.deleted`,

    frontend: `# Frontend Patterns

- Components: apps/web/src/components/
- Page views: apps/web/src/views/
- Hooks: apps/web/src/hooks/
- i18n: Use \`t\` template literal for ALL user-facing strings (Lingui)
- Styling: Tailwind CSS classes only
- Server state: tRPC React Query hooks
- Modals: useModal hook
- Toasts: usePopup hook
- After adding strings: run \`pnpm lingui:extract\``,

    database: `# Database Patterns

- Schema: packages/db/src/schema/ (Drizzle ORM)
- Repos: packages/db/src/repository/*.repo.ts
- Create migration: cd packages/db && pnpm drizzle-kit generate --name "MigrationName"
- Run migration: pnpm db:migrate
- Use transactions for multi-step operations
- All tables use .enableRLS()
- Logging: import { createLogger } from "@kan/logger" -- NEVER console.log
- Use Drizzle relations for joins, not raw SQL`,
  };

  server.tool(
    "get_conventions",
    "Get Kan coding conventions and domain rules. Essential reading before making changes.",
    {
      topic: z
        .enum([
          "all",
          "soft-delete",
          "public-id",
          "index-management",
          "activity-tracking",
          "authorization",
          "api-patterns",
          "frontend",
          "database",
        ])
        .optional()
        .default("all")
        .describe("Specific topic, or 'all' for everything"),
    },
    async ({ topic }) => {
      if (topic === "all") {
        return text(Object.values(CONVENTIONS).join("\n\n---\n\n"));
      }

      const conv = CONVENTIONS[topic];
      if (conv) {
        return text(conv);
      }

      return text(
        `Unknown topic. Available: ${Object.keys(CONVENTIONS).join(", ")}`,
      );
    },
  );
  // ---- Live data tools (require POSTGRES_URL) --------------------------------

  const POSTGRES_URL = process.env.POSTGRES_URL;

  if (POSTGRES_URL) {
    const pool = new pg.Pool({
      connectionString: POSTGRES_URL,
      max: 3,
      idleTimeoutMillis: 30000,
    });

    async function query(
      sql: string,
      params: unknown[] = [],
    ): Promise<pg.QueryResult> {
      const client = await pool.connect();
      try {
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    }

    server.tool(
      "list_workspaces",
      "List all workspaces with member counts and board counts.",
      {},
      async () => {
        const result = await query(`
        SELECT w."publicId", w.name, w.slug, w.plan, w."createdAt",
          (SELECT count(*) FROM workspace_members wm WHERE wm."workspaceId" = w.id AND wm."deletedAt" IS NULL) AS members,
          (SELECT count(*) FROM board b WHERE b."workspaceId" = w.id AND b."deletedAt" IS NULL) AS boards
        FROM workspace w
        WHERE w."deletedAt" IS NULL
        ORDER BY w."createdAt" DESC
      `);
        const lines = ["# Workspaces\n"];
        for (const row of result.rows) {
          lines.push(
            `- **${row.name}** (/${row.slug}) — ${row.boards} boards, ${row.members} members, plan: ${row.plan}`,
          );
        }
        return text(lines.join("\n") || "No workspaces found.");
      },
    );

    server.tool(
      "list_boards",
      "List boards in a workspace. Pass workspace slug.",
      {
        workspace: z.string().describe("Workspace slug (e.g. 'my-workspace')"),
      },
      async ({ workspace }) => {
        const result = await query(
          `
        SELECT b."publicId", b.name, b.slug, b.visibility, b.type, b."isArchived", b."createdAt",
          (SELECT count(*) FROM list l WHERE l."boardId" = b.id AND l."deletedAt" IS NULL) AS lists,
          (SELECT count(*) FROM card c JOIN list l2 ON c."listId" = l2.id WHERE l2."boardId" = b.id AND c."deletedAt" IS NULL) AS cards
        FROM board b
        JOIN workspace w ON b."workspaceId" = w.id
        WHERE w.slug = $1 AND b."deletedAt" IS NULL
        ORDER BY b."createdAt" DESC
      `,
          [workspace],
        );
        const lines = [`# Boards in /${workspace}\n`];
        for (const row of result.rows) {
          const archived = row.isArchived ? " [ARCHIVED]" : "";
          lines.push(
            `- **${row.name}** (/${row.slug}) — ${row.lists} lists, ${row.cards} cards, ${row.visibility}${archived}`,
          );
        }
        return text(
          lines.join("\n") || `No boards found for workspace "${workspace}".`,
        );
      },
    );

    server.tool(
      "list_cards",
      "List cards in a board. Pass workspace slug and board slug.",
      {
        workspace: z.string().describe("Workspace slug"),
        board: z.string().describe("Board slug"),
        list: z.string().optional().describe("Optional: filter by list name"),
      },
      async ({ workspace, board, list }) => {
        let sql = `
        SELECT c."publicId", c.title, c.index, c."dueDate",
          l.name AS list_name, l.index AS list_index,
          (SELECT count(*) FROM card_comments cc WHERE cc."cardId" = c.id AND cc."deletedAt" IS NULL) AS comments,
          (SELECT count(*) FROM "_card_labels" WHERE "cardId" = c.id) AS labels,
          (SELECT count(*) FROM "_card_workspace_members" WHERE "cardId" = c.id) AS members
        FROM card c
        JOIN list l ON c."listId" = l.id
        JOIN board b ON l."boardId" = b.id
        JOIN workspace w ON b."workspaceId" = w.id
        WHERE w.slug = $1 AND b.slug = $2 AND c."deletedAt" IS NULL AND l."deletedAt" IS NULL
      `;
        const params: string[] = [workspace, board];

        if (list) {
          sql += ` AND l.name ILIKE $3`;
          params.push(`%${list}%`);
        }

        sql += ` ORDER BY l.index ASC, c.index ASC`;

        const result = await query(sql, params);
        const lines = [
          `# Cards in /${workspace}/${board}${list ? ` (list: ${list})` : ""}\n`,
        ];
        let currentList = "";
        for (const row of result.rows) {
          if (row.list_name !== currentList) {
            currentList = row.list_name;
            lines.push(`\n## ${currentList}`);
          }
          const due = row.dueDate
            ? ` | due: ${new Date(row.dueDate).toLocaleDateString()}`
            : "";
          const meta = [
            row.labels > 0 ? `${row.labels} labels` : "",
            row.members > 0 ? `${row.members} members` : "",
            row.comments > 0 ? `${row.comments} comments` : "",
          ]
            .filter(Boolean)
            .join(", ");
          lines.push(
            `  ${row.index + 1}. **${row.title}** (${row.publicId})${due}${meta ? ` — ${meta}` : ""}`,
          );
        }
        return text(lines.join("\n") || `No cards found.`);
      },
    );

    server.tool(
      "get_card",
      "Get full details of a card by its publicId, including description, labels, members, comments, and checklists.",
      { id: z.string().describe("Card publicId (12-char string)") },
      async ({ id }) => {
        // Card
        const cardRes = await query(
          `
        SELECT c."publicId", c.title, c.description, c.index, c."dueDate", c."createdAt",
          l.name AS list_name, b.name AS board_name, w.name AS workspace_name
        FROM card c
        JOIN list l ON c."listId" = l.id
        JOIN board b ON l."boardId" = b.id
        JOIN workspace w ON b."workspaceId" = w.id
        WHERE c."publicId" = $1 AND c."deletedAt" IS NULL
      `,
          [id],
        );
        if (cardRes.rows.length === 0) return text(`Card "${id}" not found.`);
        const card = cardRes.rows[0];

        // Labels
        const labelsRes = await query(
          `
        SELECT lb.name, lb."colourCode" FROM label lb
        JOIN "_card_labels" jcl ON jcl."labelId" = lb.id
        JOIN card c ON jcl."cardId" = c.id
        WHERE c."publicId" = $1 AND lb."deletedAt" IS NULL
      `,
          [id],
        );

        // Members
        const membersRes = await query(
          `
        SELECT u.name, u.email FROM "user" u
        JOIN workspace_members wm ON wm."userId" = u.id
        JOIN "_card_workspace_members" jcm ON jcm."workspaceMemberId" = wm.id
        JOIN card c ON jcm."cardId" = c.id
        WHERE c."publicId" = $1 AND wm."deletedAt" IS NULL
      `,
          [id],
        );

        // Comments
        const commentsRes = await query(
          `
        SELECT cc.comment, cc."createdAt", u.name AS author
        FROM card_comments cc
        JOIN "user" u ON cc."createdBy" = u.id
        JOIN card c ON cc."cardId" = c.id
        WHERE c."publicId" = $1 AND cc."deletedAt" IS NULL
        ORDER BY cc."createdAt" ASC
      `,
          [id],
        );

        // Checklists
        const checklistsRes = await query(
          `
        SELECT cl.name AS checklist_name,
          ci.title AS item_title, ci.completed
        FROM card_checklist cl
        JOIN card c ON cl."cardId" = c.id
        LEFT JOIN card_checklist_item ci ON ci."checklistId" = cl.id AND ci."deletedAt" IS NULL
        WHERE c."publicId" = $1 AND cl."deletedAt" IS NULL
        ORDER BY cl.index ASC, ci.index ASC
      `,
          [id],
        );

        const lines = [
          `# ${card.title}`,
          `**Board:** ${card.workspace_name} / ${card.board_name} / ${card.list_name}`,
          `**Created:** ${new Date(card.createdAt).toLocaleDateString()}`,
          card.dueDate
            ? `**Due:** ${new Date(card.dueDate).toLocaleDateString()}`
            : "",
          "",
          card.description || "_No description_",
        ].filter((l) => l !== undefined);

        if (labelsRes.rows.length) {
          lines.push(
            "",
            "**Labels:** " +
              labelsRes.rows.map((l: { name: string }) => l.name).join(", "),
          );
        }
        if (membersRes.rows.length) {
          lines.push(
            "**Members:** " +
              membersRes.rows.map((m: { name: string }) => m.name).join(", "),
          );
        }
        if (commentsRes.rows.length) {
          lines.push("", "## Comments");
          for (const c of commentsRes.rows) {
            lines.push(
              `- **${c.author}** (${new Date(c.createdAt).toLocaleDateString()}): ${c.comment}`,
            );
          }
        }
        if (checklistsRes.rows.length) {
          lines.push("", "## Checklists");
          let currentCl = "";
          for (const item of checklistsRes.rows) {
            if (item.checklist_name !== currentCl) {
              currentCl = item.checklist_name;
              lines.push(`\n### ${currentCl}`);
            }
            if (item.item_title) {
              lines.push(
                `  - [${item.completed ? "x" : " "}] ${item.item_title}`,
              );
            }
          }
        }

        return text(lines.join("\n"));
      },
    );

    server.tool(
      "search_cards",
      "Search cards by title across all boards in a workspace.",
      {
        workspace: z.string().describe("Workspace slug"),
        query: z.string().describe("Search term"),
      },
      async ({ workspace, query: q }) => {
        const result = await query(
          `
        SELECT c."publicId", c.title, l.name AS list_name, b.name AS board_name
        FROM card c
        JOIN list l ON c."listId" = l.id
        JOIN board b ON l."boardId" = b.id
        JOIN workspace w ON b."workspaceId" = w.id
        WHERE w.slug = $1 AND c.title ILIKE $2 AND c."deletedAt" IS NULL AND l."deletedAt" IS NULL AND b."deletedAt" IS NULL
        ORDER BY c."updatedAt" DESC
        LIMIT 20
      `,
          [workspace, `%${q}%`],
        );
        const lines = [`# Search: "${q}" in /${workspace}\n`];
        for (const row of result.rows) {
          lines.push(
            `- **${row.title}** (${row.publicId}) — ${row.board_name} / ${row.list_name}`,
          );
        }
        return text(lines.join("\n") || `No cards matching "${q}".`);
      },
    );
    // ---- CRUD write tools ---------------------------------------------------

    function generatePublicId(): string {
      const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
      let id = "";
      const bytes = new Uint8Array(12);
      crypto.getRandomValues(bytes);
      for (const b of bytes) id += alphabet[b % alphabet.length];
      return id;
    }

    server.tool(
      "create_card",
      "Create a new card in a list. Returns the new card's publicId.",
      {
        workspace: z.string().describe("Workspace slug"),
        board: z.string().describe("Board slug"),
        list: z.string().describe("List name"),
        title: z.string().describe("Card title"),
        description: z
          .string()
          .optional()
          .describe("Card description (HTML or plain text)"),
        dueDate: z
          .string()
          .optional()
          .describe("Due date ISO string (e.g. '2026-04-15')"),
      },
      async ({ workspace, board, list, title, description, dueDate }) => {
        // Resolve listId
        const listRes = await query(
          `
        SELECT l.id FROM list l
        JOIN board b ON l."boardId" = b.id
        JOIN workspace w ON b."workspaceId" = w.id
        WHERE w.slug = $1 AND b.slug = $2 AND l.name ILIKE $3 AND l."deletedAt" IS NULL
        LIMIT 1
      `,
          [workspace, board, list],
        );
        if (listRes.rows.length === 0)
          return text(`List "${list}" not found in /${workspace}/${board}.`);
        const listId = listRes.rows[0].id;

        // Get next index
        const idxRes = await query(
          `SELECT COALESCE(MAX(index), -1) + 1 AS next FROM card WHERE "listId" = $1 AND "deletedAt" IS NULL`,
          [listId],
        );
        const index = idxRes.rows[0].next;

        const publicId = generatePublicId();
        const activityPublicId = generatePublicId();

        await query(`BEGIN`);
        try {
          await query(
            `
          INSERT INTO card ("publicId", title, description, index, "listId", "dueDate", "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        `,
            [
              publicId,
              title,
              description ?? null,
              index,
              listId,
              dueDate ?? null,
            ],
          );

          // Get the new card's id
          const cardRes = await query(
            `SELECT id FROM card WHERE "publicId" = $1`,
            [publicId],
          );
          const cardId = cardRes.rows[0].id;

          await query(
            `
          INSERT INTO card_activity ("publicId", type, "cardId", "createdAt")
          VALUES ($1, 'card.created', $2, NOW())
        `,
            [activityPublicId, cardId],
          );

          await query(`COMMIT`);
        } catch (err) {
          await query(`ROLLBACK`);
          throw err;
        }

        return text(`Created card **${title}** (${publicId}) in ${list}.`);
      },
    );

    server.tool(
      "update_card",
      "Update a card's title, description, due date, or move it to a different list.",
      {
        id: z.string().describe("Card publicId"),
        title: z.string().optional().describe("New title"),
        description: z.string().optional().describe("New description"),
        dueDate: z
          .string()
          .optional()
          .describe("New due date ISO string, or 'remove' to clear it"),
        list: z
          .string()
          .optional()
          .describe("Move to this list name (must be in same board)"),
      },
      async ({ id, title, description, dueDate, list }) => {
        // Get current card
        const cardRes = await query(
          `
        SELECT c.id, c.title, c.description, c."dueDate", c.index, c."listId",
          l.name AS list_name, l."boardId"
        FROM card c JOIN list l ON c."listId" = l.id
        WHERE c."publicId" = $1 AND c."deletedAt" IS NULL
      `,
          [id],
        );
        if (cardRes.rows.length === 0) return text(`Card "${id}" not found.`);
        const card = cardRes.rows[0];

        const updates: string[] = [`"updatedAt" = NOW()`];
        const params: unknown[] = [];
        const changes: string[] = [];

        if (title !== undefined && title !== card.title) {
          params.push(title);
          updates.push(`title = $${params.length}`);
          changes.push(`title: "${card.title}" → "${title}"`);
        }
        if (description !== undefined && description !== card.description) {
          params.push(description);
          updates.push(`description = $${params.length}`);
          changes.push("description updated");
        }
        if (dueDate !== undefined) {
          const newDue = dueDate === "remove" ? null : dueDate;
          params.push(newDue);
          updates.push(`"dueDate" = $${params.length}`);
          changes.push(
            dueDate === "remove" ? "due date removed" : `due date → ${dueDate}`,
          );
        }

        let newListId = card.listId;
        if (list !== undefined) {
          const listRes = await query(
            `
          SELECT id, name FROM list WHERE "boardId" = $1 AND name ILIKE $2 AND "deletedAt" IS NULL LIMIT 1
        `,
            [card.boardId, `%${list}%`],
          );
          if (listRes.rows.length === 0)
            return text(`List "${list}" not found in this board.`);
          newListId = listRes.rows[0].id;
          if (newListId !== card.listId) {
            // Get next index in target list
            const idxRes = await query(
              `SELECT COALESCE(MAX(index), -1) + 1 AS next FROM card WHERE "listId" = $1 AND "deletedAt" IS NULL`,
              [newListId],
            );
            params.push(newListId);
            updates.push(`"listId" = $${params.length}`);
            params.push(idxRes.rows[0].next);
            updates.push(`index = $${params.length}`);
            changes.push(`moved to "${listRes.rows[0].name}"`);
          }
        }

        if (changes.length === 0) return text("No changes to make.");

        params.push(card.id);
        await query(
          `UPDATE card SET ${updates.join(", ")} WHERE id = $${params.length}`,
          params,
        );

        return text(
          `Updated card (${id}):\n${changes.map((c) => `  - ${c}`).join("\n")}`,
        );
      },
    );

    server.tool(
      "delete_card",
      "Soft-delete a card by its publicId.",
      { id: z.string().describe("Card publicId") },
      async ({ id }) => {
        const res = await query(
          `
        UPDATE card SET "deletedAt" = NOW() WHERE "publicId" = $1 AND "deletedAt" IS NULL
        RETURNING title
      `,
          [id],
        );
        if (res.rowCount === 0)
          return text(`Card "${id}" not found or already deleted.`);
        return text(`Deleted card **${res.rows[0].title}** (${id}).`);
      },
    );

    server.tool(
      "create_list",
      "Create a new list in a board.",
      {
        workspace: z.string().describe("Workspace slug"),
        board: z.string().describe("Board slug"),
        name: z.string().describe("List name"),
      },
      async ({ workspace, board, name }) => {
        const boardRes = await query(
          `
        SELECT b.id FROM board b
        JOIN workspace w ON b."workspaceId" = w.id
        WHERE w.slug = $1 AND b.slug = $2 AND b."deletedAt" IS NULL LIMIT 1
      `,
          [workspace, board],
        );
        if (boardRes.rows.length === 0)
          return text(`Board "${board}" not found in /${workspace}.`);
        const boardId = boardRes.rows[0].id;

        const idxRes = await query(
          `SELECT COALESCE(MAX(index), -1) + 1 AS next FROM list WHERE "boardId" = $1 AND "deletedAt" IS NULL`,
          [boardId],
        );
        const publicId = generatePublicId();

        await query(
          `
        INSERT INTO list ("publicId", name, index, "boardId", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, NOW(), NOW())
      `,
          [publicId, name, idxRes.rows[0].next, boardId],
        );

        return text(
          `Created list **${name}** (${publicId}) in /${workspace}/${board}.`,
        );
      },
    );

    server.tool(
      "create_board",
      "Create a new board in a workspace.",
      {
        workspace: z.string().describe("Workspace slug"),
        name: z.string().describe("Board name"),
        description: z.string().optional().describe("Board description"),
        visibility: z
          .enum(["private", "public"])
          .optional()
          .default("private")
          .describe("Visibility"),
      },
      async ({ workspace, name, description, visibility }) => {
        const wsRes = await query(
          `SELECT id FROM workspace WHERE slug = $1 AND "deletedAt" IS NULL LIMIT 1`,
          [workspace],
        );
        if (wsRes.rows.length === 0)
          return text(`Workspace "${workspace}" not found.`);
        const workspaceId = wsRes.rows[0].id;

        // Generate slug from name
        const slug = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        const uniqueSlug = `${slug}-${generatePublicId().slice(0, 6)}`;
        const publicId = generatePublicId();

        await query(
          `
        INSERT INTO board ("publicId", name, description, slug, "workspaceId", visibility, type, "isArchived", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, 'regular', false, NOW(), NOW())
      `,
          [
            publicId,
            name,
            description ?? null,
            uniqueSlug,
            workspaceId,
            visibility,
          ],
        );

        return text(
          `Created board **${name}** (${publicId}) in /${workspace}.\nSlug: /${uniqueSlug}`,
        );
      },
    );
    // ---- Comments -------------------------------------------------------

    server.tool(
      "add_comment",
      "Add a comment to a card.",
      {
        id: z.string().describe("Card publicId"),
        comment: z.string().describe("Comment text"),
      },
      async ({ id, comment }) => {
        const cardRes = await query(
          `SELECT id FROM card WHERE "publicId" = $1 AND "deletedAt" IS NULL`,
          [id],
        );
        if (cardRes.rows.length === 0) return text(`Card "${id}" not found.`);
        const cardId = cardRes.rows[0].id;
        const publicId = generatePublicId();
        await query(
          `INSERT INTO card_comments ("publicId", comment, "cardId", "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW())`,
          [publicId, comment, cardId],
        );
        return text(`Added comment to card ${id}.`);
      },
    );

    // ---- Labels ---------------------------------------------------------

    server.tool(
      "create_label",
      "Create a new label on a board.",
      {
        workspace: z.string().describe("Workspace slug"),
        board: z.string().describe("Board slug"),
        name: z.string().min(1).max(36).describe("Label name"),
        colourCode: z
          .string()
          .length(7)
          .describe("Hex colour code (e.g. '#ef4444')"),
      },
      async ({ workspace, board, name, colourCode }) => {
        const boardRes = await query(
          `SELECT b.id FROM board b
           JOIN workspace w ON b."workspaceId" = w.id
           WHERE w.slug = $1 AND b.slug = $2 AND b."deletedAt" IS NULL LIMIT 1`,
          [workspace, board],
        );
        if (boardRes.rows.length === 0)
          return text(`Board "${board}" not found in /${workspace}.`);
        const boardId = boardRes.rows[0].id;

        const publicId = generatePublicId();
        await query(
          `INSERT INTO label ("publicId", name, "colourCode", "boardId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, NOW(), NOW())`,
          [publicId, name, colourCode, boardId],
        );

        return text(
          `Created label **${name}** (${publicId}) on /${workspace}/${board} with colour ${colourCode}.`,
        );
      },
    );

    server.tool(
      "list_labels",
      "List all labels available on a board.",
      {
        workspace: z.string().describe("Workspace slug"),
        board: z.string().describe("Board slug"),
      },
      async ({ workspace, board }) => {
        const result = await query(
          `SELECT lb."publicId", lb.name, lb."colourCode"
         FROM label lb
         JOIN board b ON lb."boardId" = b.id
         JOIN workspace w ON b."workspaceId" = w.id
         WHERE w.slug = $1 AND b.slug = $2 AND lb."deletedAt" IS NULL
         ORDER BY lb.name`,
          [workspace, board],
        );
        const lines = [`# Labels in /${workspace}/${board}\n`];
        for (const row of result.rows) {
          lines.push(
            `- **${row.name}** (${row.publicId})${row.colourCode ? ` — ${row.colourCode}` : ""}`,
          );
        }
        return text(lines.join("\n") || "No labels found.");
      },
    );

    server.tool(
      "add_label_to_card",
      "Add a label to a card.",
      {
        cardId: z.string().describe("Card publicId"),
        labelId: z.string().describe("Label publicId"),
      },
      async ({ cardId, labelId }) => {
        const cardRes = await query(
          `SELECT id FROM card WHERE "publicId" = $1 AND "deletedAt" IS NULL`,
          [cardId],
        );
        if (cardRes.rows.length === 0)
          return text(`Card "${cardId}" not found.`);
        const labelRes = await query(
          `SELECT id, name FROM label WHERE "publicId" = $1 AND "deletedAt" IS NULL`,
          [labelId],
        );
        if (labelRes.rows.length === 0)
          return text(`Label "${labelId}" not found.`);
        await query(
          `INSERT INTO "_card_labels" ("cardId", "labelId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [cardRes.rows[0].id, labelRes.rows[0].id],
        );
        return text(
          `Added label **${labelRes.rows[0].name}** to card ${cardId}.`,
        );
      },
    );

    server.tool(
      "remove_label_from_card",
      "Remove a label from a card.",
      {
        cardId: z.string().describe("Card publicId"),
        labelId: z.string().describe("Label publicId"),
      },
      async ({ cardId, labelId }) => {
        const cardRes = await query(
          `SELECT id FROM card WHERE "publicId" = $1 AND "deletedAt" IS NULL`,
          [cardId],
        );
        if (cardRes.rows.length === 0)
          return text(`Card "${cardId}" not found.`);
        const labelRes = await query(
          `SELECT id, name FROM label WHERE "publicId" = $1`,
          [labelId],
        );
        if (labelRes.rows.length === 0)
          return text(`Label "${labelId}" not found.`);
        await query(
          `DELETE FROM "_card_labels" WHERE "cardId" = $1 AND "labelId" = $2`,
          [cardRes.rows[0].id, labelRes.rows[0].id],
        );
        return text(
          `Removed label **${labelRes.rows[0].name}** from card ${cardId}.`,
        );
      },
    );

    // ---- List management ------------------------------------------------

    server.tool(
      "update_list",
      "Rename a list.",
      {
        workspace: z.string().describe("Workspace slug"),
        board: z.string().describe("Board slug"),
        list: z.string().describe("Current list name"),
        name: z.string().describe("New name"),
      },
      async ({ workspace, board, list, name }) => {
        const res = await query(
          `UPDATE list SET name = $1, "updatedAt" = NOW()
         WHERE id = (
           SELECT l.id FROM list l
           JOIN board b ON l."boardId" = b.id
           JOIN workspace w ON b."workspaceId" = w.id
           WHERE w.slug = $2 AND b.slug = $3 AND l.name ILIKE $4 AND l."deletedAt" IS NULL
           LIMIT 1
         ) RETURNING "publicId"`,
          [name, workspace, board, `%${list}%`],
        );
        if (res.rowCount === 0)
          return text(`List "${list}" not found in /${workspace}/${board}.`);
        return text(`Renamed list to **${name}**.`);
      },
    );

    server.tool(
      "delete_list",
      "Soft-delete a list and all its cards.",
      {
        workspace: z.string().describe("Workspace slug"),
        board: z.string().describe("Board slug"),
        list: z.string().describe("List name"),
      },
      async ({ workspace, board, list }) => {
        const listRes = await query(
          `SELECT l.id, l.name FROM list l
         JOIN board b ON l."boardId" = b.id
         JOIN workspace w ON b."workspaceId" = w.id
         WHERE w.slug = $1 AND b.slug = $2 AND l.name ILIKE $3 AND l."deletedAt" IS NULL
         LIMIT 1`,
          [workspace, board, `%${list}%`],
        );
        if (listRes.rows.length === 0) return text(`List "${list}" not found.`);
        const listId = listRes.rows[0].id;
        await query(`BEGIN`);
        try {
          await query(
            `UPDATE card SET "deletedAt" = NOW() WHERE "listId" = $1 AND "deletedAt" IS NULL`,
            [listId],
          );
          await query(`UPDATE list SET "deletedAt" = NOW() WHERE id = $1`, [
            listId,
          ]);
          await query(`COMMIT`);
        } catch (err) {
          await query(`ROLLBACK`);
          throw err;
        }
        return text(
          `Deleted list **${listRes.rows[0].name}** and all its cards.`,
        );
      },
    );

    // ---- Board management -----------------------------------------------

    server.tool(
      "update_board",
      "Update a board's name, description, or visibility. Can also archive/unarchive.",
      {
        workspace: z.string().describe("Workspace slug"),
        board: z.string().describe("Board slug"),
        name: z.string().optional().describe("New name"),
        description: z.string().optional().describe("New description"),
        visibility: z
          .enum(["private", "public"])
          .optional()
          .describe("New visibility"),
        archived: z
          .boolean()
          .optional()
          .describe("true to archive, false to unarchive"),
      },
      async ({ workspace, board, name, description, visibility, archived }) => {
        const boardRes = await query(
          `SELECT b.id FROM board b JOIN workspace w ON b."workspaceId" = w.id
         WHERE w.slug = $1 AND b.slug = $2 AND b."deletedAt" IS NULL LIMIT 1`,
          [workspace, board],
        );
        if (boardRes.rows.length === 0)
          return text(`Board "${board}" not found.`);
        const boardId = boardRes.rows[0].id;

        const updates: string[] = [`"updatedAt" = NOW()`];
        const params: unknown[] = [];
        const changes: string[] = [];

        if (name !== undefined) {
          params.push(name);
          updates.push(`name = $${params.length}`);
          changes.push(`name → "${name}"`);
        }
        if (description !== undefined) {
          params.push(description);
          updates.push(`description = $${params.length}`);
          changes.push("description updated");
        }
        if (visibility !== undefined) {
          params.push(visibility);
          updates.push(`visibility = $${params.length}`);
          changes.push(`visibility → ${visibility}`);
        }
        if (archived !== undefined) {
          params.push(archived);
          updates.push(`"isArchived" = $${params.length}`);
          changes.push(archived ? "archived" : "unarchived");
        }

        if (changes.length === 0) return text("No changes to make.");
        params.push(boardId);
        await query(
          `UPDATE board SET ${updates.join(", ")} WHERE id = $${params.length}`,
          params,
        );
        return text(
          `Updated board /${board}:\n${changes.map((c) => `  - ${c}`).join("\n")}`,
        );
      },
    );

    server.tool(
      "delete_board",
      "Soft-delete a board.",
      {
        workspace: z.string().describe("Workspace slug"),
        board: z.string().describe("Board slug"),
      },
      async ({ workspace, board }) => {
        const res = await query(
          `UPDATE board SET "deletedAt" = NOW()
         WHERE slug = $2 AND "workspaceId" = (SELECT id FROM workspace WHERE slug = $1 AND "deletedAt" IS NULL)
         AND "deletedAt" IS NULL RETURNING name`,
          [workspace, board],
        );
        if (res.rowCount === 0) return text(`Board "${board}" not found.`);
        return text(`Deleted board **${res.rows[0].name}**.`);
      },
    );

    // ---- Checklists -----------------------------------------------------

    server.tool(
      "create_checklist",
      "Create a checklist on a card.",
      {
        cardId: z.string().describe("Card publicId"),
        name: z.string().describe("Checklist name"),
      },
      async ({ cardId, name }) => {
        const cardRes = await query(
          `SELECT id FROM card WHERE "publicId" = $1 AND "deletedAt" IS NULL`,
          [cardId],
        );
        if (cardRes.rows.length === 0)
          return text(`Card "${cardId}" not found.`);
        const cId = cardRes.rows[0].id;
        const idxRes = await query(
          `SELECT COALESCE(MAX(index), -1) + 1 AS next FROM card_checklist WHERE "cardId" = $1 AND "deletedAt" IS NULL`,
          [cId],
        );
        const publicId = generatePublicId();
        await query(
          `INSERT INTO card_checklist ("publicId", name, index, "cardId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, NOW(), NOW())`,
          [publicId, name, idxRes.rows[0].next, cId],
        );
        return text(
          `Created checklist **${name}** (${publicId}) on card ${cardId}.`,
        );
      },
    );

    server.tool(
      "add_checklist_item",
      "Add an item to a checklist.",
      {
        checklistId: z.string().describe("Checklist publicId"),
        title: z.string().describe("Item title"),
      },
      async ({ checklistId, title }) => {
        const clRes = await query(
          `SELECT id FROM card_checklist WHERE "publicId" = $1 AND "deletedAt" IS NULL`,
          [checklistId],
        );
        if (clRes.rows.length === 0)
          return text(`Checklist "${checklistId}" not found.`);
        const clId = clRes.rows[0].id;
        const idxRes = await query(
          `SELECT COALESCE(MAX(index), -1) + 1 AS next FROM card_checklist_item WHERE "checklistId" = $1 AND "deletedAt" IS NULL`,
          [clId],
        );
        const publicId = generatePublicId();
        await query(
          `INSERT INTO card_checklist_item ("publicId", title, completed, index, "checklistId", "createdAt", "updatedAt") VALUES ($1, $2, false, $3, $4, NOW(), NOW())`,
          [publicId, title, idxRes.rows[0].next, clId],
        );
        return text(`Added item **${title}** (${publicId}) to checklist.`);
      },
    );

    server.tool(
      "toggle_checklist_item",
      "Mark a checklist item as completed or incomplete.",
      {
        itemId: z.string().describe("Checklist item publicId"),
        completed: z
          .boolean()
          .describe("true to complete, false to uncomplete"),
      },
      async ({ itemId, completed }) => {
        const res = await query(
          `UPDATE card_checklist_item SET completed = $1, "updatedAt" = NOW()
         WHERE "publicId" = $2 AND "deletedAt" IS NULL RETURNING title`,
          [completed, itemId],
        );
        if (res.rowCount === 0)
          return text(`Checklist item "${itemId}" not found.`);
        return text(
          `${completed ? "✓" : "○"} **${res.rows[0].title}** marked as ${completed ? "completed" : "incomplete"}.`,
        );
      },
    );

    // ---- Members --------------------------------------------------------

    server.tool(
      "list_members",
      "List members of a workspace.",
      { workspace: z.string().describe("Workspace slug") },
      async ({ workspace }) => {
        const result = await query(
          `SELECT u.name, u.email, wm."publicId", wm.role, wm.status
         FROM workspace_members wm
         JOIN "user" u ON wm."userId" = u.id
         JOIN workspace w ON wm."workspaceId" = w.id
         WHERE w.slug = $1 AND wm."deletedAt" IS NULL
         ORDER BY wm.role, u.name`,
          [workspace],
        );
        const lines = [`# Members of /${workspace}\n`];
        for (const row of result.rows) {
          lines.push(
            `- **${row.name}** (${row.email}) — ${row.role}, ${row.status}, id: ${row.publicId}`,
          );
        }
        return text(lines.join("\n") || "No members found.");
      },
    );

    server.tool(
      "assign_member",
      "Assign a workspace member to a card.",
      {
        cardId: z.string().describe("Card publicId"),
        memberId: z
          .string()
          .describe(
            "Workspace member publicId (from list_members)",
          ),
      },
      async ({ cardId, memberId }) => {
        const cardRes = await query(
          `SELECT id FROM card WHERE "publicId" = $1 AND "deletedAt" IS NULL`,
          [cardId],
        );
        if (cardRes.rows.length === 0)
          return text(`Card "${cardId}" not found.`);
        const cId = cardRes.rows[0].id;

        const memberRes = await query(
          `SELECT wm.id, u.name FROM workspace_members wm
           JOIN "user" u ON wm."userId" = u.id
           WHERE wm."publicId" = $1 AND wm."deletedAt" IS NULL`,
          [memberId],
        );
        if (memberRes.rows.length === 0)
          return text(`Member "${memberId}" not found.`);
        const wmId = memberRes.rows[0].id;
        const memberName = memberRes.rows[0].name;

        // Check if already assigned
        const existing = await query(
          `SELECT 1 FROM "_card_workspace_members" WHERE "cardId" = $1 AND "workspaceMemberId" = $2`,
          [cId, wmId],
        );
        if (existing.rows.length > 0)
          return text(
            `**${memberName}** is already assigned to card ${cardId}.`,
          );

        await query(
          `INSERT INTO "_card_workspace_members" ("cardId", "workspaceMemberId") VALUES ($1, $2)`,
          [cId, wmId],
        );

        // Activity record
        const actPubId = generatePublicId();
        await query(
          `INSERT INTO card_activity ("publicId", type, "cardId", "workspaceMemberId", "createdAt")
           VALUES ($1, 'card.updated.member.added', $2, $3, NOW())`,
          [actPubId, cId, wmId],
        );

        return text(`Assigned **${memberName}** to card ${cardId}.`);
      },
    );

    server.tool(
      "unassign_member",
      "Remove a workspace member from a card.",
      {
        cardId: z.string().describe("Card publicId"),
        memberId: z
          .string()
          .describe(
            "Workspace member publicId (from list_members)",
          ),
      },
      async ({ cardId, memberId }) => {
        const cardRes = await query(
          `SELECT id FROM card WHERE "publicId" = $1 AND "deletedAt" IS NULL`,
          [cardId],
        );
        if (cardRes.rows.length === 0)
          return text(`Card "${cardId}" not found.`);
        const cId = cardRes.rows[0].id;

        const memberRes = await query(
          `SELECT wm.id, u.name FROM workspace_members wm
           JOIN "user" u ON wm."userId" = u.id
           WHERE wm."publicId" = $1 AND wm."deletedAt" IS NULL`,
          [memberId],
        );
        if (memberRes.rows.length === 0)
          return text(`Member "${memberId}" not found.`);
        const wmId = memberRes.rows[0].id;
        const memberName = memberRes.rows[0].name;

        const del = await query(
          `DELETE FROM "_card_workspace_members" WHERE "cardId" = $1 AND "workspaceMemberId" = $2`,
          [cId, wmId],
        );
        if (del.rowCount === 0)
          return text(
            `**${memberName}** is not assigned to card ${cardId}.`,
          );

        // Activity record
        const actPubId = generatePublicId();
        await query(
          `INSERT INTO card_activity ("publicId", type, "cardId", "workspaceMemberId", "createdAt")
           VALUES ($1, 'card.updated.member.removed', $2, $3, NOW())`,
          [actPubId, cId, wmId],
        );

        return text(`Removed **${memberName}** from card ${cardId}.`);
      },
    );

    // ---- Epics (parent/child cards) ----------------------------------------

    server.tool(
      "set_parent",
      "Set a card's parent (epic). Pass null parentId to remove.",
      {
        cardId: z.string().describe("Child card publicId"),
        parentId: z
          .string()
          .nullable()
          .describe("Parent card publicId, or null to remove"),
      },
      async ({ cardId, parentId }) => {
        const cardRes = await query(
          `SELECT id, title FROM card WHERE "publicId" = $1 AND "deletedAt" IS NULL`,
          [cardId],
        );
        if (cardRes.rows.length === 0) return text(`Card "${cardId}" not found.`);
        const card = cardRes.rows[0];

        if (parentId === null) {
          await query(
            `UPDATE card SET "parentId" = NULL, "updatedAt" = NOW() WHERE id = $1`,
            [card.id],
          );
          return text(`Removed parent from card **${card.title}**.`);
        }

        const parentRes = await query(
          `SELECT id, title FROM card WHERE "publicId" = $1 AND "deletedAt" IS NULL`,
          [parentId],
        );
        if (parentRes.rows.length === 0)
          return text(`Parent card "${parentId}" not found.`);
        const parent = parentRes.rows[0];

        if (parent.id === card.id)
          return text("A card cannot be its own parent.");

        await query(
          `UPDATE card SET "parentId" = $1, "updatedAt" = NOW() WHERE id = $2`,
          [parent.id, card.id],
        );

        return text(
          `Set **${parent.title}** as parent of **${card.title}**.`,
        );
      },
    );

    server.tool(
      "list_epics",
      "List all epics (cards with children) in a board.",
      {
        workspace: z.string().describe("Workspace slug"),
        board: z.string().describe("Board slug"),
      },
      async ({ workspace, board }) => {
        const result = await query(
          `
          SELECT DISTINCT p."publicId", p.title, p."dueDate",
            l.name AS list_name,
            (SELECT count(*) FROM card c2 WHERE c2."parentId" = p.id AND c2."deletedAt" IS NULL) AS total,
            (SELECT count(*) FROM card c3
              JOIN list l2 ON c3."listId" = l2.id
              WHERE c3."parentId" = p.id AND c3."deletedAt" IS NULL
              AND l2.name ILIKE '%done%') AS done
          FROM card p
          JOIN list l ON p."listId" = l.id
          JOIN board b ON l."boardId" = b.id
          JOIN workspace w ON b."workspaceId" = w.id
          WHERE w.slug = $1 AND b.slug = $2
            AND p."deletedAt" IS NULL AND l."deletedAt" IS NULL
            AND EXISTS (SELECT 1 FROM card c WHERE c."parentId" = p.id AND c."deletedAt" IS NULL)
          ORDER BY p.title
        `,
          [workspace, board],
        );

        const lines = [`# Epics in /${workspace}/${board}\n`];
        for (const row of result.rows) {
          const due = row.dueDate
            ? ` | due: ${new Date(row.dueDate).toLocaleDateString()}`
            : "";
          lines.push(
            `- **${row.title}** (${row.publicId}) — ${row.done}/${row.total} done, list: ${row.list_name}${due}`,
          );
        }
        return text(lines.join("\n") || "No epics found.");
      },
    );

    server.tool(
      "list_children",
      "List child cards of an epic (parent card).",
      {
        parentId: z.string().describe("Parent card publicId"),
      },
      async ({ parentId }) => {
        const parentRes = await query(
          `SELECT id, title FROM card WHERE "publicId" = $1 AND "deletedAt" IS NULL`,
          [parentId],
        );
        if (parentRes.rows.length === 0)
          return text(`Card "${parentId}" not found.`);
        const parent = parentRes.rows[0];

        const result = await query(
          `
          SELECT c."publicId", c.title, c.index, c."dueDate", l.name AS list_name
          FROM card c
          JOIN list l ON c."listId" = l.id
          WHERE c."parentId" = $1 AND c."deletedAt" IS NULL
          ORDER BY l.index, c.index
        `,
          [parent.id],
        );

        const lines = [`# Children of **${parent.title}** (${parentId})\n`];
        for (const row of result.rows) {
          const due = row.dueDate
            ? ` | due: ${new Date(row.dueDate).toLocaleDateString()}`
            : "";
          lines.push(
            `- **${row.title}** (${row.publicId}) — ${row.list_name}${due}`,
          );
        }
        return text(lines.join("\n") || "No children found.");
      },
    );
  } // end if POSTGRES_URL
} // end registerTools

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function checkAuth(req: IncomingMessage): boolean {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) return true; // no token configured = allow all
  const auth = req.headers.authorization;
  return auth === `Bearer ${token}`;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const port = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : null;

  if (!port) {
    // ---- Stdio mode (local development) ----
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  // ---- HTTP mode (cloud deployment) ----
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // CORS
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Mcp-Session-Id",
      );
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health check (no auth required)
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ status: "ok", server: "kan-mcp", version: "1.0.0" }),
        );
        return;
      }

      // Auth check on /mcp
      if (!checkAuth(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      if (req.url !== "/mcp") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found. Use /mcp or /health" }));
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      try {
        if (req.method === "POST") {
          const body = await parseBody(req);

          // Existing session?
          if (sessionId && sessions.has(sessionId)) {
            const transport = sessions.get(sessionId)!;
            await transport.handleRequest(req, res, body);
            return;
          }

          // New session (initialize request)
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });

          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };

          const mcpServer = createServer();
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, body);

          // Store by transport's own session ID
          if (transport.sessionId) {
            sessions.set(transport.sessionId, transport);
          }
        } else if (req.method === "GET" || req.method === "DELETE") {
          if (sessionId && sessions.has(sessionId)) {
            const transport = sessions.get(sessionId)!;
            await transport.handleRequest(req, res);
            if (req.method === "DELETE") sessions.delete(sessionId);
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid session" }));
          }
        } else {
          res.writeHead(405);
          res.end();
        }
      } catch (err) {
        console.error("MCP request error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      }
    },
  );

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(
      `Kan MCP server (HTTP) listening on http://0.0.0.0:${port}/mcp`,
    );
    console.log(`Health check: http://0.0.0.0:${port}/health`);
    if (!process.env.MCP_AUTH_TOKEN) {
      console.log("WARNING: No MCP_AUTH_TOKEN set. Server is unauthenticated.");
    }
  });
}

main().catch((err) => {
  console.error("Kan MCP server failed to start:", err);
  process.exit(1);
});
