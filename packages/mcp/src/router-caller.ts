import { eq } from "drizzle-orm";

import { appRouter } from "@kan/api/root";
import { createInnerTRPCContext } from "@kan/api/trpc";
import type { dbClient } from "@kan/db/client";
import { createDrizzleClient } from "@kan/db/client";
import { users } from "@kan/db/schema";

type Caller = ReturnType<typeof appRouter.createCaller>;

let cachedDb: dbClient | undefined;
let cachedCaller: Caller | undefined;
let cachedUserId: string | undefined;

async function resolveActingUser(db: dbClient) {
  const email = process.env.MCP_ACTING_USER_EMAIL?.trim().toLowerCase();
  if (!email) {
    throw new Error(
      "MCP_ACTING_USER_EMAIL is required for mutating MCP tools — set it to the email of the Kan user the MCP should act as.",
    );
  }
  const row = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  if (!row) {
    throw new Error(
      `MCP_ACTING_USER_EMAIL "${email}" did not match any user in the Kan database.`,
    );
  }
  return {
    id: row.id,
    name: row.name ?? "",
    email: row.email,
    emailVerified: row.emailVerified,
    image: row.image ?? null,
    stripeCustomerId: row.stripeCustomerId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getRouterCaller(): Promise<Caller> {
  if (cachedCaller) return cachedCaller;
  if (!cachedDb) cachedDb = createDrizzleClient();
  const user = await resolveActingUser(cachedDb);
  cachedUserId = user.id;
  const ctx = createInnerTRPCContext({
    user,
    db: cachedDb,
    auth: {} as never,
    headers: new Headers(),
    transport: "trpc",
  });
  cachedCaller = appRouter.createCaller(ctx);
  return cachedCaller;
}

export function getActingUserId(): string | undefined {
  return cachedUserId;
}
