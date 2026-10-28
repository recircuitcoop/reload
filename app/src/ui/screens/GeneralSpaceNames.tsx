// Configuration › General › AI apps: "Tell AI apps the names of my spaces" (plan 0033 D, decision
// D2), with the one line on what it sends. On unless turned off; counts from the next connection.
// A file of its own so the AI apps section around it can change without touching it.
import { useCallback, useEffect, useState } from "react";
import type { AppApi } from "../contract";
import { Switch } from "../components/atoms/Switch";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { t } from "../strings";

export function SpaceNamesSwitch({ api }: { readonly api: AppApi }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  // A new key after every answer: a refused move puts Ark's already-flipped checkbox back.
  const [answers, answered] = useState(0);
  const read = useCallback(() => {
    api.spaceNamesToAiApps().then(setOn, () => {
      // Unread stays unread: the switch is not drawn when its state is unknown.
    });
  }, [api]);
  useEffect(read, [read]);
  const turn = (next: boolean) => {
    setFailed(false);
    api.setSpaceNamesToAiApps(next).then(
      (stored) => {
        setOn(stored);
        answered((n) => n + 1);
      },
      () => {
        answered((n) => n + 1);
        setFailed(true);
      },
    );
  };
  if (on === null) {
    return null;
  }
  return (
    <div data-testid="general-space-names" data-on={String(on)} className="flex flex-col gap-1">
      <Switch
        key={answers}
        testId="general-space-names-switch"
        state={on ? "on" : "off"}
        label={t("general.aiApps.spaceNames")}
        onStateChange={(state) => {
          turn(state === "on");
        }}
      />
      <p data-testid="general-space-names-what" className="text-caption text-secondary">
        {t("general.aiApps.spaceNames.what")}
      </p>
      {failed ? (
        <div data-testid="general-space-names-message">
          <InlineMessage kind="failed">{t("general.aiApps.spaceNames.failed")}</InlineMessage>
        </div>
      ) : null}
    </div>
  );
}
