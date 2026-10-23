// Configuration › General › Advanced (ux-writing: "the status details (runtime, services, ports)
// live here, for support"). What the old status and Settings pages showed for support: each
// supervised child's state with its process, port and generation, Anytype's state and its
// bridge's process, the MCP endpoint served against saved, where secrets are kept, and the old
// installation's leftovers with their Delete button, and where the log is, with Show log (plan 0031
// group I). These are the only internals General shows, as values beside a label, never inside a
// sentence.
import { useCallback, useEffect, useState } from "react";
import type {
  AnytypeStatus,
  AppApi,
  ChildState,
  ChildStatus,
  McpEndpointStatus,
  SecretStorageStatus,
} from "../contract";
import { Button } from "../components/atoms/Button";
import { StatusPill, type StatusPillState } from "../components/atoms/StatusPill";
import { NumberField } from "../components/atoms/NumberField";
import { Field } from "../components/molecules/Field";
import { KeyValue } from "../components/molecules/KeyValue";
import { GeneralSection } from "../components/organisms/GeneralSection";
import { LIMIT_FIELDS, limitErrors, limitsToSave, limitsTyped } from "../general";
import type { LimitValues, NodeProcessRow } from "../general-contract";
import { useChildren } from "../store";
import { t, type PlainKey } from "../strings";

/** A child's state as the status pill words it: running, restarting, or stopped. */
const CHILD_WORD: Readonly<Record<ChildState, readonly [StatusPillState, PlainKey]>> = {
  starting: ["waiting", "status.restarting"],
  running: ["running", "status.running"],
  "restarting-planned": ["waiting", "status.restarting"],
  restarting: ["waiting", "status.restarting"],
  recovering: ["waiting", "status.restarting"],
  down: ["waiting", "status.restarting"],
  "down-for-good": ["failed", "status.stopped"],
  stopped: ["failed", "status.stopped"],
};

const CHILD_LABEL: Readonly<Record<ChildStatus["child"], PlainKey>> = {
  runtime: "general.advanced.runtime",
  services: "general.advanced.services",
};

/** "4242 · 31011 · 3": the process, the port and the generation, blank where there is none. */
const processLine = (status: ChildStatus) =>
  [status.pid ?? "–", status.port ?? "–", status.generation].map(String).join(" · ");

/** A node process's state in a pill: running, coming up, coming back, or stopped for good. */
const NODE_WORD: Readonly<Record<NodeProcessRow["state"], readonly [StatusPillState, PlainKey]>> = {
  running: ["running", "status.running"],
  starting: ["waiting", "status.starting"],
  restarting: ["waiting", "status.restarting"],
  stopped: ["failed", "status.stopped"],
};

/** Each of the runtime's node processes with its state and pid, and why one stopped for good. */
function NodeRows({ rows }: { readonly rows: readonly NodeProcessRow[] }) {
  return (
    <div data-testid="general-advanced-nodes" className="flex flex-col">
      <KeyValue
        kind="text"
        label={t("general.advanced.nodes")}
        value={rows.length === 0 ? t("general.advanced.nodes.none") : ""}
      />
      {rows.map((row, index) => {
        const [look, word] = NODE_WORD[row.state];
        return (
          <KeyValue
            key={`${row.name}-${String(index)}`}
            kind="pill"
            label={row.name}
            value={
              <span data-testid="general-advanced-node" data-state={row.state}>
                <StatusPill state={look}>{t(word)}</StatusPill>{" "}
                {[row.pid ?? "–", row.why ?? ""].filter((part) => part !== "").join(" · ")}
              </span>
            }
          />
        );
      })}
    </div>
  );
}

function ChildRows({ status }: { readonly status: ChildStatus }) {
  const [look, word] = CHILD_WORD[status.state];
  return (
    <div data-testid={`general-child-${status.child}`} data-state={status.state}>
      <KeyValue
        kind="pill"
        label={t(CHILD_LABEL[status.child])}
        value={<StatusPill state={look}>{t(word)}</StatusPill>}
      />
      <KeyValue
        kind="mono"
        label={t("general.advanced.process")}
        value={
          <span data-testid={`general-child-${status.child}-process`}>{processLine(status)}</span>
        }
      />
    </div>
  );
}

export function AdvancedSection({
  api,
  anytype,
  endpoint,
}: {
  readonly api: AppApi;
  readonly anytype: AnytypeStatus | null;
  readonly endpoint: McpEndpointStatus | null;
}) {
  const children = useChildren();
  const [secrets, setSecrets] = useState<SecretStorageStatus | null>(null);
  const [legacy, setLegacy] = useState<readonly string[]>([]);
  const [log, setLog] = useState<string | null>(null);
  const [nodes, setNodes] = useState<readonly NodeProcessRow[] | null>(null);
  useEffect(() => {
    api.nodeProcesses().then(
      (answer) => {
        if (answer.ok) setNodes(answer.value);
      },
      () => undefined,
    );
    api.secretStorage().then(setSecrets, () => undefined);
    api.legacyPackages().then(setLegacy, () => undefined);
    api.logFile().then(
      (answer) => {
        if (answer.ok) setLog(answer.value.path);
      },
      () => undefined,
    );
  }, [api]);
  const showLog = useCallback(() => {
    void api.showLog();
  }, [api]);
  const deleteLegacy = useCallback(() => {
    api.deleteLegacyPackages().then(
      () => {
        setLegacy([]);
      },
      () => undefined,
    );
  }, [api]);
  const statuses =
    children.status === "ready"
      ? [...children.value].sort((a, b) => a.child.localeCompare(b.child))
      : [];
  return (
    <GeneralSection
      section="advanced"
      title={t("general.advanced")}
      state={t("general.advanced.line")}
    >
      <div data-testid="general-advanced" className="flex flex-col">
        {statuses.map((status) => (
          <ChildRows key={status.child} status={status} />
        ))}
        {nodes === null ? null : <NodeRows rows={nodes} />}
        {anytype === null ? null : (
          <div data-testid="general-advanced-anytype" data-state={anytype.state}>
            <KeyValue
              kind="mono"
              label={t("general.advanced.anytype")}
              value={
                anytype.detail === null ? anytype.state : `${anytype.state} · ${anytype.detail}`
              }
            />
            <KeyValue
              kind="mono"
              label={t("general.advanced.anytypeProcess")}
              value={`${anytype.childPid === null ? "–" : String(anytype.childPid)} · ${String(anytype.beats)}`}
            />
          </div>
        )}
        {endpoint === null ? null : <EndpointRows status={endpoint} />}
        {secrets === null ? null : (
          <KeyValue
            kind="text"
            label={t("general.advanced.secrets")}
            value={
              <span data-testid="general-advanced-secrets" data-backend={secrets.backend}>
                {t(
                  secrets.backend === "keychain"
                    ? "general.advanced.secrets.keychain"
                    : "general.advanced.secrets.file",
                )}
                {secrets.reason === null ? null : ` (${secrets.reason})`}
              </span>
            }
          />
        )}
        {log === null ? null : (
          <div data-testid="general-advanced-log" className="flex flex-col gap-2">
            <KeyValue kind="mono" label={t("general.advanced.log")} value={log} />
            <div>
              <Button kind="secondary" onClick={showLog} data-testid="general-advanced-log-show">
                {t("general.advanced.log.show")}
              </Button>
            </div>
          </div>
        )}
        <LimitsForm api={api} />
        {legacy.length === 0 ? null : (
          <div data-testid="general-advanced-legacy" className="flex flex-col gap-2">
            <KeyValue kind="mono" label={t("general.advanced.legacy")} value={legacy.join(", ")} />
            <div>
              <Button kind="secondary" onClick={deleteLegacy}>
                {t("general.advanced.legacy.delete")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </GeneralSection>
  );
}

/** The endpoint served, the saved one when it differs, the variables it beats, and the problem. */
function EndpointRows({ status }: { readonly status: McpEndpointStatus }) {
  return (
    <div data-testid="general-advanced-endpoint">
      <KeyValue kind="mono" label={t("general.advanced.endpoint")} value={status.served ?? "–"} />
      {status.saved === status.served ? null : (
        <KeyValue kind="mono" label={t("general.advanced.saved")} value={status.saved ?? "–"} />
      )}
      {status.ignoredVariables.length === 0 ? null : (
        <KeyValue
          kind="mono"
          label={t("general.advanced.ignored")}
          value={status.ignoredVariables.join(", ")}
        />
      )}
      {status.problem === null ? null : (
        <KeyValue kind="text" label={t("general.advanced.endpoint")} value={status.problem} />
      )}
    </div>
  );
}

/**
 * Stability defaults (plan 0031, the old helper form's group): the person's own resource limits,
 * every field refused in words by the shell's rules before anything is written.
 */
function LimitsForm({ api }: { readonly api: AppApi }) {
  const [typed, setTyped] = useState<Record<keyof LimitValues, string> | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof LimitValues, string>>>({});
  const [said, say] = useState<PlainKey | null>(null);
  useEffect(() => {
    api.limits().then(
      (answer) => {
        if (answer.ok) setTyped(limitsTyped(answer.value));
      },
      () => undefined,
    );
  }, [api]);
  if (typed === null) {
    return null;
  }
  const save = () => {
    say(null);
    api.setLimits(limitsToSave(typed)).then(
      (answer) => {
        if (answer.ok) {
          setTyped(limitsTyped(answer.value));
          setErrors({});
          say("general.limits.saved");
        } else {
          setErrors(limitErrors(answer.refused));
          say("general.limits.refused");
        }
      },
      () => undefined,
    );
  };
  return (
    <form
      data-testid="general-limits"
      className="flex flex-col gap-3 pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <KeyValue kind="text" label={t("general.limits")} value={t("general.limits.line")} />
      <div className="grid grid-cols-2 gap-3">
        {LIMIT_FIELDS.map(({ key, label }) => (
          <Field
            key={key}
            label={t(label)}
            state={errors[key] === undefined ? "default" : "error"}
            {...(errors[key] === undefined ? {} : { error: errors[key] })}
          >
            {(control) => (
              <NumberField
                id={control.id}
                testId={`general-limits-${key}`}
                state={control.state === "error" ? "error" : "default"}
                value={typed[key]}
                onValueChange={(value) => {
                  setTyped({ ...typed, [key]: value });
                }}
                incrementLabel={t("general.port.more")}
                decrementLabel={t("general.port.less")}
              />
            )}
          </Field>
        ))}
      </div>
      <div>
        <Button kind="secondary" type="submit" data-testid="general-limits-save">
          {t("general.limits.save")}
        </Button>
      </div>
      {said === null ? null : (
        <p data-testid="general-limits-message" className="text-caption text-secondary">
          {t(said)}
        </p>
      )}
    </form>
  );
}
