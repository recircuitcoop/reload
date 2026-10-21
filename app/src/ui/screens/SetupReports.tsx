// Setup's Reports step (plan 0022 §H): the reports question beside the full privacy notice (D25),
// apart from SetupScreen.tsx. The same step is asked again on launch, on its own, after a yes to
// an older privacy notice (plan 0029 WI-07): ReportsAgain, which the frame shows.
import { useState, type ReactNode } from "react";
import type { Refusal } from "../answer";
import type { AppApi } from "../contract";
import type { SetupMove } from "../general-contract";
import { Button } from "../components/atoms/Button";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { SetupStep } from "../components/organisms/SetupStep";
import { Sidebar } from "../components/organisms/Sidebar";
import { WindowSetup } from "../components/templates/WindowSetup";
import { t } from "../strings";
import { wordRefusal } from "../words";
import { PrivacyNotice } from "./PrivacyNotice";

/**
 * The reports question asked again on launch, after a yes to an older privacy notice (plan 0029
 * WI-07): Setup's Reports step on its own, with no way back to a Setup that is over. Either
 * answer closes it.
 */
export function ReportsAgain({
  api,
  pill,
  banner,
  onAnswered,
}: {
  readonly api: AppApi;
  readonly pill: ReactNode;
  readonly banner: ReactNode;
  readonly onAnswered: () => void;
}) {
  const [refusal, say] = useState<Refusal | null>(null);
  const move = (): Promise<boolean> => {
    onAnswered();
    return Promise.resolve(true);
  };
  return (
    <WindowSetup
      sidebar={
        <Sidebar
          mode="setup"
          label={t("nav.setup")}
          steps={[t("setup.nav.reports")]}
          current={0}
          status={pill}
        />
      }
    >
      {banner}
      <div data-testid="setup-step" data-step="reports" className="flex flex-col gap-4">
        <ReportsStep api={api} move={move} say={say} back={false} />
        {refusal === null ? null : (
          <div data-testid="setup-message">
            <InlineMessage kind="failed">{wordRefusal(refusal)}</InlineMessage>
          </div>
        )}
      </div>
    </WindowSetup>
  );
}

/** Setup's Reports step: the question, its two answers, and the privacy notice between them. */
export function ReportsStep({
  api,
  move,
  say,
  back = true,
}: {
  readonly api: AppApi;
  readonly move: (move: SetupMove) => Promise<boolean>;
  readonly say: (refusal: Refusal | null) => void;
  /** Back into Setup; not when the question is asked again after Setup is over. */
  readonly back?: boolean;
}) {
  /** The answer, then on: the switch in Configuration › General says the same. */
  const answer = (on: boolean) => {
    api.setTelemetry(on).then(
      () => void move({ kind: "next" }),
      () => {
        say({ reason: "failed", sentence: "refused.failed" });
      },
    );
  };
  return (
    <SetupStep
      title={t("setup.reports.title")}
      body={t("setup.reports.body")}
      actions={
        <>
          {back ? (
            <Button
              kind="quiet"
              data-testid="setup-back"
              onClick={() => void move({ kind: "back" })}
            >
              {t("setup.back")}
            </Button>
          ) : null}
          <Button
            kind="secondary"
            data-testid="setup-reports-dont-send"
            onClick={() => {
              answer(false);
            }}
          >
            {t("setup.reports.dontSend")}
          </Button>
          <Button
            kind="primary"
            data-testid="setup-reports-send"
            onClick={() => {
              answer(true);
            }}
          >
            {t("setup.reports.send")}
          </Button>
        </>
      }
    >
      <PrivacyNotice level={2} />
    </SetupStep>
  );
}
