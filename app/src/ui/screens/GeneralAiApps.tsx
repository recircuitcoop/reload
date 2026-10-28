// Configuration › General › AI apps, one row per AI app Reload can connect (plan 0033 §C,
// WI-0033-04; owner, 2026-10-28: "changeable in the configuration"). Each row says the state of
// Reload's entry in that app's server list and offers Connect, Disconnect or Repair, over the
// same calls Setup's step makes; the page never sees the file. Built over the list the services
// give, so a client added later appears here with no change. Supersedes WI-0022-30's copy steps.
import { useEffect, useState } from "react";
import type { AiAppListing, AppApi } from "../contract";
import { Button } from "../components/atoms/Button";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { aiAppLimit, aiAppState, notServedYet } from "../ai-apps";
import { t } from "../strings";

type Call = (id: string) => Promise<readonly AiAppListing[]>;

export function AiAppRows({ api }: { readonly api: AppApi }) {
  const [apps, setApps] = useState<readonly AiAppListing[] | null>(null);
  const [unlisted, setUnlisted] = useState(false);
  // The app whose press failed, and why, in words.
  const [failed, setFailed] = useState<{ readonly client: string; readonly text: string } | null>(
    null,
  );
  useEffect(() => {
    let live = true;
    api.aiApps().then(
      (listed) => {
        if (live) setApps(listed);
      },
      () => {
        if (live) setUnlisted(true);
      },
    );
    return () => {
      live = false;
    };
  }, [api]);
  const act = (app: AiAppListing, call: Call) => {
    setFailed(null);
    call(app.client).then(setApps, (error: unknown) => {
      const text = notServedYet(String(error))
        ? t("aiApps.notServed", { app: app.name })
        : t("general.aiApps.failed", { app: app.name });
      setFailed({ client: app.client, text });
    });
  };
  if (unlisted) {
    return (
      <div data-testid="general-ai-apps-unlisted">
        <InlineMessage kind="failed">{t("aiApps.unlisted")}</InlineMessage>
      </div>
    );
  }
  return (
    <div data-testid="general-ai-app-rows" className="flex flex-col gap-4">
      {(apps ?? []).map((app) => (
        <AppRow
          key={app.client}
          app={app}
          failed={failed?.client === app.client ? failed.text : null}
          onConnect={() => {
            act(app, (id) => api.connectAiApp(id));
          }}
          onDisconnect={() => {
            act(app, (id) => api.disconnectAiApp(id));
          }}
          onRepair={() => {
            act(app, (id) => api.repairAiApp(id));
          }}
        />
      ))}
    </div>
  );
}

function AppRow({
  app,
  failed,
  onConnect,
  onDisconnect,
  onRepair,
}: {
  readonly app: AiAppListing;
  readonly failed: string | null;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onRepair: () => void;
}) {
  const id = app.client;
  const connected = app.state === "connected" || app.state === "restart-app";
  const state =
    aiAppState(app) ??
    (app.found ? t("general.aiApps.notConnected") : t("general.aiApps.notFound"));
  return (
    <div data-testid={`general-ai-app-${id}`} className="flex flex-col gap-2">
      <h3
        data-testid={`general-ai-app-name-${id}`}
        className="text-body font-semibold text-primary"
      >
        {app.name}
      </h3>
      <p data-testid={`general-ai-app-state-${id}`} className="text-body text-primary">
        {state}
      </p>
      <p data-testid={`general-ai-app-limit-${id}`} className="text-body text-secondary">
        {aiAppLimit(app)}
      </p>
      <p data-testid={`general-ai-app-company-${id}`} className="text-body text-secondary">
        {t("setup.aiApps.company", { company: app.company })}
      </p>
      <div data-testid={`general-ai-app-actions-${id}`} className="flex items-center gap-2">
        {app.state === "not-connected" ? (
          <Button kind="primary" data-testid={`general-ai-app-connect-${id}`} onClick={onConnect}>
            {t("setup.aiApps.connect")}
          </Button>
        ) : null}
        {app.state === "changed-outside" ? (
          <Button kind="primary" data-testid={`general-ai-app-repair-${id}`} onClick={onRepair}>
            {t("setup.aiApps.repair")}
          </Button>
        ) : null}
        {connected ? (
          <Button
            kind="secondary"
            data-testid={`general-ai-app-disconnect-${id}`}
            onClick={onDisconnect}
          >
            {t("general.aiApps.disconnect")}
          </Button>
        ) : null}
      </div>
      {failed === null ? null : (
        <div data-testid={`general-ai-app-failed-${id}`}>
          <InlineMessage kind="failed">{failed}</InlineMessage>
        </div>
      )}
    </div>
  );
}
