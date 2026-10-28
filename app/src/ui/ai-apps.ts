// The words Setup's Connect your AI apps step and Configuration's AI apps rows share (plan 0033
// §C): an app's state, where in the app Reload is reached, and why a press did not work.
import type { AiAppListing } from "./contract";
import { t, type PlainKey } from "./strings";

/** Where each kind of app reaches Reload, said beside that app only. */
const REACHES: Record<AiAppListing["reaches"], PlainKey> = {
  "work-view": "aiApps.limit.workView",
};

export const aiAppLimit = (app: AiAppListing): string => t(REACHES[app.reaches]);

/** The state Reload's entry is in, or null when there is none to say (not connected). */
export function aiAppState(app: AiAppListing): string | null {
  if (app.state === "connected") {
    return t("setup.aiApps.connected");
  }
  if (app.state === "restart-app") {
    return t("setup.aiApps.restart", { restart: app.restartName });
  }
  return app.state === "changed-outside" ? t("setup.aiApps.changed") : null;
}

/**
 * Whether a refused press failed only because nothing is served yet: the services' refusal says
 * Reload has no endpoint address to write (application/ai-app-connections.ts), or the AI apps
 * have not started at all (services/main.ts).
 */
export const notServedYet = (reason: string): boolean =>
  reason.includes("has no endpoint address") || reason.includes("AI apps have not started");
