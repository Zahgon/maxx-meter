import type { UsagePoller } from "../poller.js";
import {
  createPanel,
  getPanel,
  listPanels,
  panelAuthOk,
  UNASSIGNED_PANEL_OWNER,
  updatePanel,
} from "../panels/registry.js";
import { loadHaOptionsFile, loadSettings } from "../config.js";
import type { PanelUsageResponse } from "../models.js";
import { createApp } from "./http.js";

export function createPanelServer(poller: UsagePoller) {
  const app = createApp();

  app.get("/api/v1/health", (_req, res) => {
    res.json({
      ok: true,
      service: "maxxmeter",
      snapshots: poller.getSnapshots().length,
    });
  });

  /** LAN first-run helper: create or return the bootstrapped office panel credentials. */
  app.post("/api/v1/setup/office-panel", async (_req, res) => {
    const options = await loadHaOptionsFile();
    if (options.bootstrap_office_panel !== true) {
      res.status(403).json({ error: "bootstrap_office_panel is disabled" });
      return;
    }

    const existing = await listPanels();
    const office =
      existing.find((p) => p.label === "Office panel" && p.deviceProfile === "nspanel-us-portrait") ??
      existing.find((p) => p.deviceProfile === "nspanel-us-portrait") ??
      existing[0];

    if (office) {
      res.json({
        created: false,
        panel_id: office.id,
        panel_api_key: office.apiKey,
        label: office.label,
        deviceProfile: office.deviceProfile,
      });
      return;
    }

    const panel = await createPanel({
      label: "Office panel",
      deviceProfile: "nspanel-us-portrait",
      ownerUserId: UNASSIGNED_PANEL_OWNER,
      accountIds: [],
    });
    res.json({
      created: true,
      panel_id: panel.id,
      panel_api_key: panel.apiKey,
      label: panel.label,
      deviceProfile: panel.deviceProfile,
    });
  });

  app.get("/api/v1/panels/:panelId/health", async (req, res) => {
    const panel = await getPanel(req.params.panelId);
    if (!panel || !panelAuthOk(panel, req.headers.authorization)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const lastSeenAt = new Date().toISOString();
    await updatePanel(panel.id, { lastSeenAt });
    res.json({
      ok: true,
      panel: { id: panel.id, label: panel.label, deviceProfile: panel.deviceProfile },
      lastSeenAt,
    });
  });

  app.get("/api/v1/panels/:panelId/usage", async (req, res) => {
    const panel = await getPanel(req.params.panelId);
    if (!panel || !panelAuthOk(panel, req.headers.authorization)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    await updatePanel(panel.id, { lastSeenAt: new Date().toISOString() });
    const settings = await loadSettings();
    const accountIds =
      panel.accountIds.length > 0
        ? panel.accountIds
        : poller
            .getSnapshotsForUser(panel.ownerUserId)
            .map((s) => s.accountId);

    const accounts = poller.getSnapshotsForAccounts(accountIds);
    const body: PanelUsageResponse = {
      panel: {
        id: panel.id,
        label: panel.label,
        deviceProfile: panel.deviceProfile,
      },
      accounts,
      thresholds: { warnPct: settings.warnPct, criticalPct: settings.criticalPct },
    };
    res.json(body);
  });

  return app;
}
