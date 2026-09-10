import type { Request } from "express";

export interface HaUserContext {
  userId: string;
  userName: string;
  isAdmin: boolean;
}

const SINGLE_USER: HaUserContext = {
  userId: "default",
  userName: "Default User",
  isAdmin: true,
};

export function resolveUserFromRequest(req: Request): HaUserContext {
  const userId = headerString(req, "x-remote-user-id");
  const userName = headerString(req, "x-remote-user-name") ?? userId ?? "User";
  const adminHeader = headerString(req, "x-remote-user-is-admin");

  if (!userId) {
    if (process.env.MAXXMETER_DEV_USER_ID) {
      return {
        userId: process.env.MAXXMETER_DEV_USER_ID,
        userName: process.env.MAXXMETER_DEV_USER_NAME ?? "Dev User",
        isAdmin: process.env.MAXXMETER_DEV_IS_ADMIN !== "false",
      };
    }
    return SINGLE_USER;
  }

  return {
    userId,
    userName,
    isAdmin: adminHeader === "true" || adminHeader === "1",
  };
}

export function resolveTargetUserId(
  ctx: HaUserContext,
  requestedUserId?: string,
): string {
  if (requestedUserId && ctx.isAdmin) return requestedUserId;
  return ctx.userId;
}

export function mergeDashboardUsers(
  accounts: { ownerUserId: string; ownerUserName?: string }[],
  panels: { ownerUserId: string }[],
): { userId: string; userName: string }[] {
  const byUser = new Map<string, string>();
  for (const panel of panels) {
    if (!byUser.has(panel.ownerUserId)) {
      byUser.set(panel.ownerUserId, panel.ownerUserId);
    }
  }
  for (const account of accounts) {
    byUser.set(account.ownerUserId, account.ownerUserName ?? account.ownerUserId);
  }
  return [...byUser.entries()]
    .map(([userId, userName]) => ({ userId, userName }))
    .sort((a, b) => a.userName.localeCompare(b.userName));
}

function headerString(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}
