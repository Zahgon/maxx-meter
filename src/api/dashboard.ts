import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Request, Response } from "express";
import { ingressBasePath, withIngressBase } from "./ingress.js";
import {
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  listAccountsForUser,
} from "../accounts/registry.js";
import { deleteCredential, getCredential, saveCredential } from "../auth/vault.js";
import {
  claudeExpiresAt,
  exchangeClaudeOAuthCode,
  startClaudeOAuth,
} from "../auth/claude-oauth.js";
import { loadSettings, saveSettings } from "../config.js";
import { GlobalSettingsSchema, ProviderIdSchema } from "../models.js";
import type { UsagePoller } from "../poller.js";
import type { MqttPublisher } from "../mqtt/publisher.js";
import {
  claimUnassignedPanels,
  createPanel,
  deletePanel,
  getPanel,
  listPanels,
  listPanelsForUser,
  regeneratePanelApiKey,
  updatePanel,
} from "../panels/registry.js";
import {
  mergeDashboardUsers,
  resolveTargetUserId,
  resolveUserFromRequest,
} from "../users/context.js";
import { createApp } from "./http.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const DASHBOARD_MISSING_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>MaxxMeter</title></head>
<body><h1>MaxxMeter</h1>
<p>The dashboard bundle is missing. Rebuild the add-on (<code>npm run build</code>) and restart.</p>
</body></html>`;

// Supervisor lives on 172.30.32.0/23; ingress requests always arrive from that subnet.
const SUPERVISOR_SUBNET = /^(?:::ffff:)?172\.30\.3[23]\.\d{1,3}$/;

function isTrustedRemote(remote: string): boolean {
  return (
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1" ||
    SUPERVISOR_SUBNET.test(remote)
  );
}

function queryString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

export async function createDashboardServer(poller: UsagePoller, mqtt?: MqttPublisher) {
  const app = createApp();

  app.use((req, res, next) => {
    const trusted =
      isTrustedRemote(req.socket.remoteAddress ?? "") ||
      process.env.MAXXMETER_TRUST_ALL_INGRESS === "true";
    if (!trusted && process.env.NODE_ENV === "production") {
      res.status(403).json({ error: "ingress only" });
      return;
    }
    next();
  });

  app.get("/api/dashboard/me", async (req, res) => {
    const user = resolveUserFromRequest(req);
    await claimUnassignedPanels(user.userId);
    res.json({ userId: user.userId, userName: user.userName, isAdmin: user.isAdmin });
  });

  app.get("/api/dashboard/users", async (req, res) => {
    const user = resolveUserFromRequest(req);
    if (!user.isAdmin) {
      res.status(403).json({ error: "admin only" });
      return;
    }
    const [accounts, panels] = await Promise.all([listAccounts(), listPanels()]);
    res.json(mergeDashboardUsers(accounts, panels));
  });

  app.get("/api/dashboard/usage", async (req, res) => {
    const user = resolveUserFromRequest(req);
    const target = resolveTargetUserId(user, queryString(req.query.userId));
    res.json(poller.getSnapshotsForUser(target));
  });

  app.get("/api/dashboard/accounts", async (req, res) => {
    const user = resolveUserFromRequest(req);
    const target = resolveTargetUserId(user, queryString(req.query.userId));
    const accounts = await listAccountsForUser(target);
    const enriched = await Promise.all(
      accounts.map(async (a) => ({
        ...a,
        connected: Boolean(await getCredential(a.id)),
      })),
    );
    res.json(enriched);
  });

  app.post("/api/dashboard/accounts", async (req, res) => {
    const user = resolveUserFromRequest(req);
    const provider = ProviderIdSchema.safeParse(req.body?.provider);
    const label = req.body?.label?.trim();
    if (!provider.success || !label) {
      res.status(400).json({ error: "provider and label required" });
      return;
    }
    const account = await createAccount({
      provider: provider.data,
      label,
      ownerUserId: user.userId,
      ownerUserName: user.userName,
    });
    res.json(account);
  });

  app.delete("/api/dashboard/accounts/:id", async (req, res) => {
    const user = resolveUserFromRequest(req);
    const account = await getAccount(req.params.id);
    if (!account) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (account.ownerUserId !== user.userId && !user.isAdmin) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    await deleteCredential(account.id);
    await deleteAccount(account.id);
    res.json({ ok: true });
  });

  app.post("/api/dashboard/accounts/:id/connect", async (req, res) => {
    const user = resolveUserFromRequest(req);
    const account = await getAccount(req.params.id);
    if (!account) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (account.ownerUserId !== user.userId && !user.isAdmin) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const token = req.body?.token?.trim();
    if (!token) {
      res.status(400).json({ error: "token required" });
      return;
    }

    const authMethod =
      req.body.authMethod === "oauth"
        ? "oauth"
        : account.provider === "kimi"
          ? "api_key"
          : account.provider === "cursor"
            ? "session"
            : "session";

    await saveCredential({
      accountId: account.id,
      ownerUserId: account.ownerUserId,
      provider: account.provider,
      authMethod,
      accessToken: token,
      connectedAt: new Date().toISOString(),
    });
    await poller.pollOnce();
    res.json({ ok: true });
  });

  app.post("/api/dashboard/accounts/:id/disconnect", async (req, res) => {
    const user = resolveUserFromRequest(req);
    const account = await getAccount(req.params.id);
    if (!account) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (account.ownerUserId !== user.userId && !user.isAdmin) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    await deleteCredential(account.id);
    await poller.pollOnce();
    res.json({ ok: true });
  });

  app.get("/api/dashboard/panels", async (req, res) => {
    const user = resolveUserFromRequest(req);
    const target = resolveTargetUserId(user, queryString(req.query.userId));
    res.json(await listPanelsForUser(target));
  });

  app.post("/api/dashboard/panels", async (req, res) => {
    const user = resolveUserFromRequest(req);
    const label = req.body?.label?.trim();
    const deviceProfile = req.body?.deviceProfile;
    if (!label || (deviceProfile !== "nspanel-eu" && deviceProfile !== "nspanel-us-portrait")) {
      res.status(400).json({ error: "label and deviceProfile required" });
      return;
    }
    const owned = await listAccountsForUser(user.userId);
    const ownedIds = new Set(owned.map((a) => a.id));
    const accountIds = (req.body.accountIds ?? owned.map((a) => a.id)).filter((id: string) =>
      ownedIds.has(id),
    );
    const panel = await createPanel({
      label,
      deviceProfile,
      ownerUserId: user.userId,
      accountIds,
    });
    res.json(panel);
  });

  app.put("/api/dashboard/panels/:id", async (req, res) => {
    const user = resolveUserFromRequest(req);
    const panel = await getPanel(req.params.id);
    if (!panel) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (panel.ownerUserId !== user.userId && !user.isAdmin) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const owned = await listAccountsForUser(panel.ownerUserId);
    const ownedIds = new Set(owned.map((a) => a.id));
    const accountIds = req.body.accountIds?.filter((id: string) => ownedIds.has(id));
    const updated = await updatePanel(panel.id, {
      label: req.body.label?.trim() || panel.label,
      accountIds: accountIds ?? panel.accountIds,
      deviceProfile:
        req.body.deviceProfile === "nspanel-eu" || req.body.deviceProfile === "nspanel-us-portrait"
          ? req.body.deviceProfile
          : panel.deviceProfile,
    });
    res.json(updated);
  });

  app.post("/api/dashboard/panels/:id/regenerate-key", async (req, res) => {
    const user = resolveUserFromRequest(req);
    const panel = await getPanel(req.params.id);
    if (!panel) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (panel.ownerUserId !== user.userId && !user.isAdmin) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.json(await regeneratePanelApiKey(panel.id));
  });

  app.delete("/api/dashboard/panels/:id", async (req, res) => {
    const user = resolveUserFromRequest(req);
    const panel = await getPanel(req.params.id);
    if (!panel) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (panel.ownerUserId !== user.userId && !user.isAdmin) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    await deletePanel(panel.id);
    res.json({ ok: true });
  });

  app.get("/api/dashboard/settings", async (req, res) => {
    const user = resolveUserFromRequest(req);
    if (!user.isAdmin) {
      res.status(403).json({ error: "admin only" });
      return;
    }
    const settings = await loadSettings();
    res.json({
      ...settings,
      ha: { ...settings.ha, token: settings.ha.token ? "***" : "" },
      mqtt: { ...settings.mqtt, password: settings.mqtt.password ? "***" : "" },
    });
  });

  app.put("/api/dashboard/settings", async (req, res) => {
    const user = resolveUserFromRequest(req);
    if (!user.isAdmin) {
      res.status(403).json({ error: "admin only" });
      return;
    }
    const current = await loadSettings();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mqttBody = body.mqtt as { password?: string } | undefined;
    const haBody = body.ha as { token?: string } | undefined;
    const next = GlobalSettingsSchema.parse({
      ...current,
      ...body,
      mqtt: {
        ...current.mqtt,
        ...(body.mqtt as object),
        password:
          mqttBody?.password === "***"
            ? current.mqtt.password
            : (mqttBody?.password ?? current.mqtt.password),
      },
      ha: {
        ...current.ha,
        ...(body.ha as object),
        token:
          haBody?.token === "***" ? current.ha.token : (haBody?.token ?? current.ha.token),
      },
    });
    await saveSettings(next);
    poller.restart();
    void poller.pollOnce();
    if (mqtt) {
      const latest = await loadSettings();
      mqtt.reconnect(latest);
    }
    res.json({ ok: true });
  });

  app.get("/api/auth/claude/start", async (req, res) => {
    const user = resolveUserFromRequest(req);
    const accountId = queryString(req.query.accountId);
    if (!accountId) {
      res.status(400).json({ error: "accountId required" });
      return;
    }

    const account = await getAccount(accountId);
    if (!account) {
      res.status(404).json({ error: "account not found" });
      return;
    }
    if (account.ownerUserId !== user.userId && !user.isAdmin) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if (account.provider !== "claude") {
      res.status(400).json({ error: "not a claude account" });
      return;
    }

    const result = await startClaudeOAuth({
      accountId: account.id,
      ownerUserId: account.ownerUserId,
    });
    res.json(result);
  });

  app.post("/api/auth/claude/exchange", async (req, res) => {
    const user = resolveUserFromRequest(req);
    const stateId = req.body?.stateId?.trim();
    const code = req.body?.code?.trim();
    if (!stateId || !code) {
      res.status(400).json({ error: "stateId and code required" });
      return;
    }

    try {
      const result = await exchangeClaudeOAuthCode({ stateId, code });
      const account = await getAccount(result.accountId);
      if (!account) {
        res.status(404).json({ error: "account not found" });
        return;
      }
      if (account.ownerUserId !== user.userId && !user.isAdmin) {
        res.status(403).json({ error: "forbidden" });
        return;
      }

      await saveCredential({
        accountId: result.accountId,
        ownerUserId: result.ownerUserId,
        provider: "claude",
        authMethod: "oauth",
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: claudeExpiresAt(result.expires_in),
        connectedAt: new Date().toISOString(),
      });
      await poller.pollOnce();
      res.json({ ok: true, accountId: result.accountId });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "OAuth exchange failed",
      });
    }
  });

  // Cursor/Kimi: token paste fallback (OAuth requires provider-registered redirect URIs)
  app.get("/api/auth/:provider/start", async (req, res) => {
    const provider = req.params.provider;
    if (provider === "claude") {
      res.status(400).json({ error: "Use /api/auth/claude/start?accountId=" });
      return;
    }
    res.redirect(
      `${ingressBasePath(req)}/accounts?oauth=manual&provider=${encodeURIComponent(provider)}`,
    );
  });

  const dashboardDist = join(__dirname, "../../dashboard/dist");
  const indexHtml = await readIndexHtml(dashboardDist);

  const sendIndex = (req: Request, res: Response) =>
    res
      .type("text/html; charset=utf-8")
      .send(withIngressBase(indexHtml, ingressBasePath(req)));

  // Intercept before express.static so the shell always carries a <base href> pointing at
  // the ingress prefix; without it the browser asks Home Assistant for ./assets and /api.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const path = req.url.split("?")[0];
    if (path === "/" || path === "/index.html") {
      sendIndex(req, res);
      return;
    }
    next();
  });

  app.use(express.static(dashboardDist, { index: false }));

  app.use((req, res) => {
    if (req.url.startsWith("/api/")) {
      res.status(404).json({ error: "not found" });
      return;
    }
    sendIndex(req, res);
  });

  return app;
}

async function readIndexHtml(dashboardDist: string): Promise<string> {
  try {
    return await readFile(join(dashboardDist, "index.html"), "utf8");
  } catch {
    console.warn(`MaxxMeter: dashboard bundle not found at ${dashboardDist}`);
    return DASHBOARD_MISSING_HTML;
  }
}
