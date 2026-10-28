// Setup's Connect AI apps step (plan 0033 §C, decision D1): each AI app found on this computer is
// offered with Connect (primary) and Skip beside it, never pre-chosen. Connecting writes Reload's
// entry in the app's server list through the services process; the page never sees the file.
// Continue is always there: an app left alone is simply not connected. Built over the list the
// services give, so a client added later appears here with no change.
import { useEffect, useState } from "react";
import type { AiAppListing, AppApi } from "../contract";
import type { SetupMove } from "../general-contract";
import { Button } from "../components/atoms/Button";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { SetupStep } from "../components/organisms/SetupStep";
import { aiAppLimit, aiAppState, notServedYet } from "../ai-apps";
import { t } from "../strings";

export function AiAppsStep({
  api,
  move,
}: {
  readonly api: AppApi;
  readonly move: (move: SetupMove) => Promise<boolean>;
}) {
  const [apps, setApps] = useState<readonly AiAppListing[] | null>(null);
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  // A list that could not be read is said as such, never as "no AI apps found".
  const [unlisted, setUnlisted] = useState(false);
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
  const found = (apps ?? []).filter((app) => app.found);
  /** Connect or Repair, then the list as the services now have it. */
  const act = (app: AiAppListing, call: (id: string) => Promise<readonly AiAppListing[]>) => {
    setFailed(null);
    call(app.client).then(setApps, (error: unknown) => {
      setFailed(
        notServedYet(String(error))
          ? t("aiApps.notServed", { app: app.name })
          : t("setup.aiApps.failed", { app: app.name }),
      );
    });
  };
  return (
    <SetupStep
      title={t("setup.aiApps.title")}
      backLabel={t("setup.back")}
      continueLabel={t("setup.continue")}
      onBack={() => void move({ kind: "back" })}
      onContinue={() => void move({ kind: "next" })}
    >
      {unlisted ? (
        <div data-testid="setup-ai-apps-unlisted">
          <InlineMessage kind="failed">{t("aiApps.unlisted")}</InlineMessage>
        </div>
      ) : apps === null ? null : found.length === 0 ? (
        <p data-testid="setup-ai-apps-none" className="text-body text-primary">
          {t("setup.aiApps.none")}
        </p>
      ) : (
        found.map((app) => (
          <AppRow
            key={app.client}
            app={app}
            skipped={skipped.includes(app.client)}
            onConnect={() => {
              act(app, (id) => api.connectAiApp(id));
            }}
            onRepair={() => {
              act(app, (id) => api.repairAiApp(id));
            }}
            onSkip={() => {
              setSkipped([...skipped, app.client]);
            }}
          />
        ))
      )}
      {failed === null ? null : (
        <div data-testid="setup-ai-apps-failed">
          <InlineMessage kind="failed">{failed}</InlineMessage>
        </div>
      )}
    </SetupStep>
  );
}

function AppRow({
  app,
  skipped,
  onConnect,
  onRepair,
  onSkip,
}: {
  readonly app: AiAppListing;
  readonly skipped: boolean;
  readonly onConnect: () => void;
  readonly onRepair: () => void;
  readonly onSkip: () => void;
}) {
  const id = app.client;
  const state = aiAppState(app) ?? (skipped ? t("setup.aiApps.skipped") : null);
  const offered = app.state === "not-connected" && !skipped;
  return (
    <div data-testid={`setup-ai-app-${id}`} className="flex flex-col gap-2">
      <p className="text-body text-primary">{t("setup.aiApps.what", { app: app.name })}</p>
      <p className="text-body text-secondary">
        {t("setup.aiApps.company", { company: app.company })}
      </p>
      <p data-testid={`setup-ai-app-limit-${id}`} className="text-caption text-secondary">
        {aiAppLimit(app)}
      </p>
      {state === null ? null : (
        <p data-testid={`setup-ai-app-state-${id}`} className="text-body text-primary">
          {state}
        </p>
      )}
      <div className="flex items-center gap-2">
        {offered ? (
          <>
            <Button kind="primary" data-testid={`setup-ai-app-connect-${id}`} onClick={onConnect}>
              {t("setup.aiApps.connect")}
            </Button>
            <Button kind="secondary" data-testid={`setup-ai-app-skip-${id}`} onClick={onSkip}>
              {t("setup.aiApps.skip")}
            </Button>
          </>
        ) : null}
        {app.state === "changed-outside" ? (
          <Button kind="primary" data-testid={`setup-ai-app-repair-${id}`} onClick={onRepair}>
            {t("setup.aiApps.repair")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
