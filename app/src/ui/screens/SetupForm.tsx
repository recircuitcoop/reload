// Setup's node forms (plan 0022 §H, ux-writing "Node forms"): one screen per step of the starter
// flow after its source, in wire order, titled "Set up: *step name*" with "Step n of N." over
// it, and what the step does (its package's description) under the title. The step's own form is
// read with nodeForm and saved with configureNode, the same calls the canvas's forms use; a field
// whose options come from Anytype (`reload`) lists them through nodeOptions, and a field marked
// advanced is not drawn (its value is saved as it was). Continue saves, and moves on only once
// the step is saved; Skip the example leaves the example's screens.
import { useEffect, useState } from "react";
import type { AppApi } from "../contract";
import type { Answer, Refusal } from "../answer";
import type { NodeForm, NodeOptions } from "../flow-contract";
import { Button } from "../components/atoms/Button";
import { Select } from "../components/atoms/Select";
import { Switch } from "../components/atoms/Switch";
import { Textarea } from "../components/atoms/Textarea";
import { TextField } from "../components/atoms/TextField";
import { Field } from "../components/molecules/Field";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { SetupStep } from "../components/organisms/SetupStep";
import {
  draftOf,
  markedParts,
  plainOf,
  problemsByField,
  setupFields,
  valuesOf,
  type Draft,
  type MarkedPart,
  type SetupField,
} from "../setup-form";
import { t } from "../strings";
import { wordRefusal } from "../words";

/** A line whose names (ux-writing's `*…*`) are drawn in italics. */
export function Marked({ parts }: { readonly parts: readonly MarkedPart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.named ? (
          <em key={index} data-testid="marked-name">
            {part.text}
          </em>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

export interface SetupFormProps {
  readonly api: AppApi;
  readonly flowId: string;
  /** The step this screen sets up. */
  readonly step: { readonly id: string; readonly name: string };
  /** Which form, from 0, of how many. */
  readonly index: number;
  readonly count: number;
  readonly onBack: () => void;
  /** The step is saved: on to the next form, or Ready. */
  readonly onSaved: () => void;
  /** Skip the example: no form saved. */
  readonly onSkip: () => void;
  /** Connect Anytype, when the spaces cannot be listed: Setup's Anytype step. */
  readonly onConnect: () => void;
}

export function SetupForm(props: SetupFormProps) {
  const { api, flowId, step, index, count, onBack, onSaved, onSkip, onConnect } = props;
  const [form, setForm] = useState<Answer<NodeForm> | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  useEffect(() => {
    let live = true;
    void api.nodeForm(flowId, step.id).then((answer) => {
      if (!live) return;
      setForm(answer);
      if (answer.ok) setDraft(draftOf(setupFields(answer.value.schema), answer.value.values));
    });
    return () => {
      live = false;
    };
  }, [api, flowId, step.id]);
  const fields = form?.ok === true ? setupFields(form.value.schema) : [];
  const problems = problemsByField(refusal?.problems);
  const title = markedParts("setup.form.title", { step: step.name });
  const save = () => {
    setRefusal(null);
    void api.configureNode(flowId, step.id, valuesOf(fields, draft)).then((saved) => {
      if (saved.ok) {
        onSaved();
      } else {
        setRefusal(saved.refused);
      }
    });
  };
  return (
    <SetupStep
      progress={t("setup.form.progress", { step: index + 1, of: count })}
      title={<Marked parts={title} />}
      label={plainOf(title)}
      {...(form?.ok === true && form.value.description !== null
        ? { body: form.value.description }
        : {})}
      backLabel={t("setup.back")}
      skipLabel={t("setup.example.skip")}
      continueLabel={t("setup.continue")}
      continueDisabled={form?.ok !== true}
      onBack={onBack}
      onSkip={onSkip}
      onContinue={save}
    >
      <div data-testid="setup-form" data-node={step.id} className="flex flex-col gap-4">
        {fields
          .filter((field) => !field.advanced)
          .map((field) => (
            <SetupFormField
              key={field.key}
              api={api}
              field={field}
              draft={draft}
              problem={problems[field.key]}
              onConnect={onConnect}
              onChange={(value) => {
                setDraft((before) => ({ ...before, [field.key]: value }));
              }}
            />
          ))}
        {form?.ok === false ? (
          <InlineMessage kind="failed">{wordRefusal(form.refused)}</InlineMessage>
        ) : null}
        {refusal === null ? null : (
          <div data-testid="setup-message">
            <InlineMessage kind="failed">
              {refusal.reason === "invalid" && refusal.params !== undefined ? (
                <Marked parts={markedParts("error.formIncomplete", refusal.params)} />
              ) : (
                wordRefusal(refusal)
              )}
            </InlineMessage>
          </div>
        )}
      </div>
    </SetupStep>
  );
}

interface FieldProps {
  readonly api: AppApi;
  readonly field: SetupField;
  readonly draft: Draft;
  readonly problem: string | undefined;
  readonly onConnect: () => void;
  readonly onChange: (value: string | boolean) => void;
}

function SetupFormField({ api, field, draft, problem, onConnect, onChange }: FieldProps) {
  const value = draft[field.key];
  const text = typeof value === "string" ? value : "";
  return (
    <div data-testid={`setup-field-${field.key}`}>
      <Field
        label={field.label}
        state={problem === undefined ? "default" : "error"}
        {...(field.help === null ? {} : { help: field.help })}
        {...(problem === undefined ? {} : { error: problem })}
      >
        {(control) => {
          if (field.readOnly) {
            // Shown, never typed over (JSON Schema readOnly).
            return (
              <TextField
                id={control.id}
                testId={`setup-field-${field.key}-text`}
                state="disabled"
                value={typeof value === "boolean" ? String(value) : text}
              />
            );
          }
          if (field.kind === "boolean") {
            return (
              <Switch
                state={value === true ? "on" : "off"}
                label={field.label}
                hideLabel
                onStateChange={(state) => {
                  onChange(state === "on");
                }}
              />
            );
          }
          if (field.kind === "enum") {
            return (
              <Select
                label={field.label}
                hideLabel
                options={field.options.map((option) => ({ value: option, label: option }))}
                value={text === "" ? null : text}
                onValueChange={(chosen) => {
                  onChange(chosen ?? "");
                }}
              />
            );
          }
          if (field.kind === "multiline") {
            // Several lines, kept as typed: a single-line input would strip the newlines.
            return (
              <Textarea
                id={control.id}
                {...(control.describedBy === undefined ? {} : { describedBy: control.describedBy })}
                state={problem === undefined ? "default" : "error"}
                value={text}
                onValueChange={onChange}
              />
            );
          }
          if (field.kind === "path") {
            const browse = () => {
              void api.choosePath(field.pathKind ?? "file").then((chosen) => {
                if (chosen.ok && chosen.value.path !== null) {
                  onChange(chosen.value.path);
                }
              });
            };
            return (
              <div className="flex items-center gap-2">
                <TextField
                  id={control.id}
                  testId={`setup-field-${field.key}-text`}
                  {...(control.describedBy === undefined
                    ? {}
                    : { describedBy: control.describedBy })}
                  state={problem === undefined ? "default" : "error"}
                  value={text}
                  onValueChange={onChange}
                />
                <Button
                  kind="secondary"
                  data-testid={`setup-field-${field.key}-browse`}
                  onClick={browse}
                >
                  {t("setup.form.browse")}
                </Button>
              </div>
            );
          }
          if (field.reload !== null) {
            return (
              <AnytypeSelect
                api={api}
                field={field}
                draft={draft}
                onConnect={onConnect}
                onChange={onChange}
              />
            );
          }
          return (
            <TextField
              id={control.id}
              testId={`setup-field-${field.key}-text`}
              {...(control.describedBy === undefined ? {} : { describedBy: control.describedBy })}
              state={problem === undefined ? "default" : "error"}
              type={field.kind === "secret" ? "password" : "text"}
              value={text}
              onValueChange={onChange}
            />
          );
        }}
      </Field>
    </div>
  );
}

/** A type key as a name, while the space's types are not listed: "page" → "Page". */
const typeName = (key: string) => key.charAt(0).toUpperCase() + key.slice(1).replaceAll("_", " ");

/**
 * A field whose options are the paired Anytype's spaces, or one space's types. When the spaces
 * cannot be read, it says to connect Anytype and offers Setup's own Anytype step for it.
 */
function AnytypeSelect({ api, field, draft, onConnect, onChange }: Omit<FieldProps, "problem">) {
  const [options, setOptions] = useState<Answer<NodeOptions> | null>(null);
  const reload = field.reload;
  const spaceId =
    reload?.source === "types" && typeof draft[reload.of] === "string"
      ? String(draft[reload.of])
      : "";
  useEffect(() => {
    let live = true;
    setOptions(null);
    if (reload === null || (reload.source === "types" && spaceId === "")) {
      return;
    }
    const query =
      reload.source === "spaces"
        ? ({ source: "spaces" } as const)
        : ({ source: "types", spaceId } as const);
    void api.nodeOptions(query).then((answer) => {
      if (live) setOptions(answer);
    });
    return () => {
      live = false;
    };
  }, [api, reload, spaceId]);
  const value = typeof draft[field.key] === "string" ? String(draft[field.key]) : "";
  const listed = options?.ok === true ? options.value.options : [];
  // The value kept is offered when the answer lacks it, never dropped; a type by its name.
  const kept = reload?.source === "types" ? typeName(value) : value;
  const choices =
    listed.some((option) => option.value === value) || value === ""
      ? listed
      : [...listed, { value, label: kept }];
  const reading = reload?.source === "types" ? t("form.readingTypes") : t("form.readingSpaces");
  return (
    <div className="flex flex-col gap-1">
      <Select
        label={field.label}
        hideLabel
        testId={`setup-field-${field.key}-select`}
        // Nothing chosen yet still says what the field wants (ux-writing's "Choose…").
        placeholder={t("question.choose")}
        state={options?.ok === true ? "default" : "disabled"}
        options={choices}
        value={value === "" ? null : value}
        onValueChange={(chosen) => {
          onChange(chosen ?? "");
        }}
      />
      {options === null && (reload?.source === "spaces" || spaceId !== "") ? (
        <p className="text-caption text-secondary">{reading}</p>
      ) : null}
      {options?.ok === false && reload?.source === "spaces" ? (
        <div data-testid="setup-form-no-spaces" className="flex flex-col items-start gap-2">
          <InlineMessage kind="warning">{t("setup.form.noSpaces")}</InlineMessage>
          <Button kind="secondary" data-testid="setup-form-connect" onClick={onConnect}>
            {t("setup.anytype.title")}
          </Button>
        </div>
      ) : null}
      {options?.ok === false && reload?.source === "types" ? (
        <InlineMessage kind="warning">{wordRefusal(options.refused)}</InlineMessage>
      ) : null}
    </div>
  );
}
