# Features the old app had that Reload lacks, grouped

Source: g1 to g7 verdict files (218 rows) plus the re-audit files re1a, re1b, re2, re3a, re3b (195 rows now missing or unsure, 4 rows moved from internal to group 15); 417 rows (377 missing, 36 unsure). Branch diffs read with `git diff main...HEAD` in the four worktrees. Read-only audit.

Sizes: S up to a day, M a few days, L a week or more. Owner words are quoted only where the owner said them; anything else is labelled as a plan author's.

## Standing rule

Owner: "finish ALL plans completely." (docs/plans/0031-the-features-the-old-app-had.md:11). On being offered a blanket retirement: "so you basically asked me to blanket approve 68 important points that are direct features I have asked to implement?" (0031:19-20). The plan's rule: every feature is ported unless the owner retires that group (0031:22-24). So absence of a decision below means the default is Port.

## Summary

| # | Title | Rows | Size | Covered / decision |
|---|---|---:|---|---|
| 1 | [DATA] Pick-several, list, long-text and file/folder controls in plugin settings | 23 | M | none |
| 2 | Settings that appear only when another setting is on (also a table column shown only when another column has a value) | 11 | S | none |
| 3 | [DATA] A plugin records a value the person sees but cannot type over; secrets in groups and rows | 19 | M | none |
| 4 | Editing a list of rows: ask before removing, the table's own row name, unique column, fold groups, nested tables, columns that carry more than text | 35 | M | none |
| 5 | Install and update a plugin from a git repository or a package index (PyPI) | 10 | L | none |
| 6 | Update channels, strict versions, and 'needs a newer app' at check time | 11 | M | none |
| 7 | Package-author workflow: live folder, editable install, replace in one step, reinstall | 7 | M | none |
| 8 | Per-package update controls: Off, pin from the app, Update all | 6 | M | none |
| 9 | Edit the stability numbers (restart attempts, delay, stop timeout, breaker window, check cadence, limits) in the app | 15 | M | none |
| 10 | Per-package terminal commands: list, start, stop, kill, restart, release | 19 | L | none |
| 11 | Bring Reload back after it crashes | 5 | M | none |
| 12 | Stop a node's child programs cleanly | 6 | M | none |
| 13 | A list of running processes with their state in the window | 2 | S | none |
| 14 | Log detail: record each emitted event, and set verbosity in a setting | 4 | S | none |
| 15 | A package that needs another package, and saying why a step is held back (4 rows added from the re-audit: 'no package can require another' is the missing feature, not an internal change) | 8 | M | none |
| 16 | Read which Anytype tools exist, even with the MCP child down | 2 | S | none |
| 17 | Developer tool to re-record the pinned Anytype MCP tool list and see what changed | 16 | M | none |
| 18 | A Reload release that changes the plugin/app API waits for the person's Apply | 6 | M | none |
| 19 | Re-check the staged update before installing it, and keep the working copy when an install fails | 2 | S | none |
| 20 | Automatic rollback of a release that fails to start | 1 | (decided) | owner decision |
| 21 | Check packages still work before an app update, and do not restart the runtime for an idle package | 5 | M | none |
| 22 | Register a catalogue source from the app | 2 | (decided) | owner decision |
| 23 | Refusals for hand-edited settings, and the Anytype key from the environment | 3 | S | none |
| 24 | Change port when the services process is down | 1 | S | none |
| 25 | Per-OS proofs: notices, shortcuts, icon, Windows update, Linux 16 px icon | 11 | M | none |
| 26 | A broken package declaration is refused at install, naming the field | 81 | M | none |
| 27 | The form shows the reason beside the field, and empty required values are caught | 20 | M | none |
| 28 | [DATA] A bad entry is no longer kept out: good fields and rows survive, the old value stays | 14 | M | none |
| 29 | A broken package is shown, not hidden | 11 | M | none |
| 30 | [DATA] A broken settings or flows file is refused, not emptied and overwritten | 3 | S | none |
| 31 | [DATA] A value for a setting the plugin stopped declaring is dropped at the next deploy | 1 | S | none |
| 32 | [SAFETY] Inputs held for a stuck node have no limit | 4 | M | none |
| 33 | [SAFETY] Node processes left behind after a runtime crash | 2 | M | none |
| 34 | [SAFETY] A kill sent to a process id after the process has exited | 1 | S | none |
| 35 | [SAFETY] The login item stays registered when macOS asks for approval | 1 | S | done: ported (port/0032-small-safety) |
| 36 | Update offers and notices that are not true | 3 | S | done: ported (port/0032-small-safety) |
| 37 | Saving one setting restarts every node in every flow | 2 | M | none |
| 38 | Show what the runtime refused, and open the right place from a notice | 2 | S | none |
| 39 | 'See what would be sent' shows the exact body that will be posted | 1 | S | none |
| 40 | [SAFETY] Unproven: no secret in a shown reason; an old package version sees only its own files while closing | 2 | S | done: ported (port/0032-small-safety) |
| - | covered by port/0031-watchdog | 7 | - | covered |
| - | covered by port/0031-supervision | 21 | - | covered |
| - | covered by port/0031-cli-log | 7 | - | covered |
| - | covered by telemetry-signals | 1 | - | covered |
| - | wrongly called missing (probably) | 3 | - | - |
| | **Total** | **417** | | |

Corrections to the brief:

1. The watchdog branch has no window form for 'Stability defaults'. The limits are read from `limits` in `shell-settings.json` only (`ports/settings-store.ts`, LimitDefaultsSetting: 'Edited in the file only, as the old one was'). The form and the other supervision numbers are group 9.
2. None of the first 218 rows carries an `owner_ack` in the ledger. The owner decisions found are in plan 0022 and owner-review.md, and they cover groups 20 and 22 only.
2b. The re-audit rows are disjoint from the first 218, so no earlier row was removed. Rows it judged internal or equivalent are left out. The brief said 5 'no package can require another' rows; I found 4 in re2 (`test_an_addon_the_resolver_holds_back_is_never_spawned`, `test_up_names_an_addon_the_resolver_holds_back...`, `test_a_plugin_another_one_requires_is_refused_by_name`, `test_a_plugin_another_one_requires_is_drawn_as_not_removable`). The six 're2 internal' update-group rows (`test_plugin_update_apply.py::test_a_group_in_which_...`) are related but were not moved; say if the fifth is one of them.
2c. The flows.json fix on `fix/flows-file-refused` has no commits yet, so group 30 is marked in progress, not covered.
3. The three candidate decisions: signed-catalogue-only installs has no owner words (group 5); 'Go back' D4 is the owner's (group 20); plan 0013's refusal is a plan author's, and plan 0013 is superseded (group 7).

## Groups

### 1. [DATA] Pick-several, list, long-text and file/folder controls in plugin settings

- **Old app / now:** The old settings window gave a plugin a list-of-values box, a pick-several box, a multi-line text box and a Browse button for a file or folder. Now all of those are one-line text boxes: lists and paths are typed by hand. DATA LOSS: a list is read back from the form as text, so saving the form can wipe a stored list, and a list column in a table row becomes text and the stored list is lost. A number field also no longer carries its min/max/step.
- **Size:** M. Lives in: `domain/forms/form-model.ts` (controlOf) and the editor form, driven by JSON Schema array/enum/format hints.
- **Owner decision:** none
- **Rows (23):**

- `tests/test_addon_settings.py::test_a_list_of_each_non_list_type_parses[choice]`
- `tests/test_addon_settings.py::test_a_list_of_each_non_list_type_parses[multiple-choice]`
- `tests/test_addon_settings.py::test_a_list_of_each_non_list_type_parses[number]`
- `tests/test_addon_settings.py::test_a_list_of_each_non_list_type_parses[paragraph]`
- `tests/test_addon_settings.py::test_a_list_of_each_non_list_type_parses[path]`
- `tests/test_addon_settings.py::test_a_list_of_each_non_list_type_parses[secret]`
- `tests/test_addon_settings.py::test_a_list_of_each_non_list_type_parses[switch]`
- `tests/test_addon_settings.py::test_a_list_of_each_non_list_type_parses[text]`
- `tests/test_addon_settings.py::test_a_multiple_choice_default_is_kept_as_a_tuple`
- `tests/test_addon_settings.py::test_one_field_of_each_of_the_nine_types_parses_with_its_own_constraints`
- `tests/test_plugin_page.py::test_every_one_of_the_ten_field_types_has_its_own_drawing`
- `tests/test_settings_store.py::test_a_switch_and_a_list_survive_a_round_trip` (UNSURE)
- `tests/test_table_drawing.py::test_a_rows_cells_are_the_widgets_their_own_columns_already_have`
- `tests/test_plugin_page.py::test_a_scalar_type_whose_drawing_is_removed_fails_loudly[multiple-choice]`
- `tests/test_plugin_page.py::test_a_scalar_type_whose_drawing_is_removed_fails_loudly[paragraph]`
- `tests/test_plugin_page.py::test_a_scalar_type_whose_drawing_is_removed_fails_loudly[path]`
- `tests/test_plugin_page.py::test_a_widget_the_toolkit_cannot_build_fails_loudly[checkbox-group]`
- `tests/test_plugin_page.py::test_a_widget_the_toolkit_cannot_build_fails_loudly[multiline-text-input]`
- `tests/test_plugin_page.py::test_a_widget_the_toolkit_cannot_build_fails_loudly[path-picker]`
- `tests/test_plugin_page.py::test_a_drawn_field_carries_everything_its_widget_is_built_from`
- `tests/test_settings_store.py::test_a_list_whose_elements_break_their_constraint_is_refused`
- `tests/test_plugin_page.py::test_a_widget_the_toolkit_cannot_build_fails_loudly[repeating-list]`
- `tests/test_table_drawing.py::test_the_toolkit_builds_one_row_of_widgets_for_every_recorded_row`

### 2. Settings that appear only when another setting is on (also a table column shown only when another column has a value)

- **Old app / now:** A setting could say 'show me only when that switch is on', so irrelevant fields stayed hidden. Now every field is always shown.
- **Size:** S. Lives in: `domain/forms/form-model.ts` and the editor form: honour a conditional hint (JSON Schema if/then or an x- key).
- **Owner decision:** none
- **Rows (11):**

- `tests/test_addon_settings.py::test_a_shown_when_naming_another_field_parses`
- `tests/test_plugin_page.py::test_a_dependent_fields_drawing_follows_the_form_across_two_requests`
- `tests/test_plugin_page.py::test_the_drawing_never_re_evaluates_shown_when`
- `tests/test_settings_form.py::test_a_condition_is_not_satisfied_by_a_value_of_another_type`
- `tests/test_settings_form.py::test_a_condition_may_name_a_field_declared_after_it`
- `tests/test_settings_form.py::test_a_dependent_fields_visibility_follows_the_field_it_names`
- `tests/test_table_declaration.py::test_a_row_field_s_shown_when_may_name_another_field_of_the_same_row`
- `tests/test_table_declaration.py::test_a_row_field_shown_when_naming_a_field_outside_its_own_row_is_refused`
- `tests/test_table_declaration.py::test_a_row_field_shown_when_naming_a_sibling_table_s_row_field_is_refused`
- `tests/test_table_declaration.py::test_a_row_field_shown_when_naming_an_enclosing_row_s_field_is_refused`
- `tests/test_table_declaration.py::test_a_row_field_shown_when_naming_itself_is_refused`

### 3. [DATA] A plugin records a value the person sees but cannot type over; secrets in groups and rows

- **Old app / now:** A plugin could write a value back into its own settings (an OAuth token it obtained) and the window said 'recorded by the plugin, at this time'. Now a step cannot store a secret it obtains while running, and nothing shows who set a value. DATA LOSS: a secret declared inside a group or a table row is silently left off the form and never stored, a secret's default is dropped, and the settings file no longer records who wrote a value or when.
- **Size:** M. Lives in: `adapters/nodered/registration.ts` (credential write-back) and `domain/forms/form-model.ts` (read-only, attributed field).
- **Owner decision:** none
- **Check:** UNSURE row (a token the person cannot read back): check whether a node can already write its own Node-RED credential at run time and whether the form hides it.
- **Rows (19):**

- `tests/test_addon_settings_runtime.py::test_a_plugin_writes_a_secret_that_is_never_readable_back_but_reaches_the_plugin` (UNSURE)
- `tests/test_addon_settings_runtime.py::test_a_plugins_table_write_is_attributed_to_the_plugin_rather_than_to_the_user`
- `tests/test_addon_settings_runtime.py::test_a_plugins_write_is_attributed_to_the_plugin_and_a_persons_to_the_user`
- `tests/test_plugin_page.py::test_a_field_only_the_plugin_writes_is_drawn_read_only`
- `tests/test_settings_form.py::test_a_value_the_plugin_wrote_is_published_with_who_wrote_it`
- `tests/test_settings_store.py::test_a_plugin_writing_its_own_value_is_recorded_as_the_writer`
- `tests/test_settings_store.py::test_a_write_records_who_made_it_and_when`
- `tests/test_table_store.py::test_a_table_write_records_one_writer_and_one_timestamp_however_many_rows_it_touched`
- `tests/test_plugin_secrets.py::test_a_plugin_may_store_its_own_secret`
- `tests/test_addon_settings.py::test_a_default_of_the_field_s_own_type_is_kept[field6-hunter2]`
- `tests/test_addon_settings.py::test_a_secret_carries_the_same_common_attributes_as_any_other_field`
- `tests/test_settings_store.py::test_a_field_written_by_both_takes_either_writer`
- `tests/test_settings_store.py::test_a_plugin_may_not_write_a_field_its_author_left_to_the_user`
- `tests/test_settings_store.py::test_no_write_may_be_made_in_another_plugins_name`
- `tests/test_settings_store.py::test_the_file_reads_as_values_and_an_attribution_table`
- `tests/test_settings_store.py::test_the_user_may_not_write_a_field_its_author_left_to_the_plugin`
- `tests/test_table_store.py::test_a_secret_column_in_a_nested_row_is_named_by_its_path_through_the_declaration`
- `tests/test_table_store.py::test_a_table_with_a_secret_column_is_refused_rather_than_written_to_this_file`
- `tests/test_plugin_page.py::test_a_scalar_type_whose_drawing_is_removed_fails_loudly[secret]`

### 4. Editing a list of rows: ask before removing, the table's own row name, unique column, fold groups, nested tables, columns that carry more than text

- **Old app / now:** In a table setting, Remove asked first when the row held something, the buttons used the table's own word ('Add city'), a column marked unique refused repeats by naming both rows, and nested groups could be folded. Now Remove deletes at once, buttons say 'Add row', repeats are accepted.
- **Size:** M. Lives in: `domain/forms/form-model.ts` table control and the editor form; unique check in `adapters/nodered/registration.ts`.
- **Owner decision:** none. The old owner answers were plan 0005 D3 (unique column) and D5 (ask first when the row is not empty) (docs/plans/0005-a-table-of-records.md:465, :476); no new plan retires them.
- **Rows (35):**

- `tests/test_table_drawing.py::test_a_collapsed_group_is_its_rows_first_column_alone`
- `tests/test_table_drawing.py::test_a_removal_nobody_asked_about_is_refused`
- `tests/test_table_drawing.py::test_a_row_that_holds_something_is_not_removed_until_it_is_confirmed`
- `tests/test_table_drawing.py::test_a_row_with_a_nested_row_in_it_is_never_empty`
- `tests/test_table_drawing.py::test_keeping_a_row_puts_the_question_away_and_changes_nothing_else`
- `tests/test_table_drawing.py::test_the_add_control_says_what_the_plugin_calls_a_row`
- `tests/test_table_drawing.py::test_the_remove_control_asks_on_the_row_and_takes_it_out_when_answered`
- `tests/test_table_store.py::test_a_repeated_unique_value_refuses_both_rows_each_naming_the_other`
- `tests/test_table_store.py::test_a_row_that_leaves_its_unique_column_empty_is_compared_with_nobody`
- `tests/test_table_declaration.py::test_a_nested_table_may_mark_its_own_unique_column`
- `tests/test_table_declaration.py::test_a_row_field_keeps_the_optional_attributes_every_field_carries`
- `tests/test_table_declaration.py::test_a_row_holds_one_field_of_each_type_with_its_own_constraints`
- `tests/test_table_declaration.py::test_a_row_label_that_is_not_a_string_is_refused[1]`
- `tests/test_table_declaration.py::test_a_row_label_that_is_not_a_string_is_refused[None]`
- `tests/test_table_declaration.py::test_a_row_label_that_is_not_a_string_is_refused[row_label1]`
- `tests/test_table_declaration.py::test_an_empty_row_label_is_refused`
- `tests/test_table_declaration.py::test_a_table_declares_a_row_and_a_row_label`
- `tests/test_table_declaration.py::test_a_table_nested_three_levels_deep_keeps_every_level_s_row_and_row_label`
- `tests/test_table_declaration.py::test_a_unique_marking_that_is_not_true_or_false_is_refused[1]`
- `tests/test_table_declaration.py::test_a_unique_marking_that_is_not_true_or_false_is_refused[None]`
- `tests/test_table_declaration.py::test_a_unique_marking_that_is_not_true_or_false_is_refused[yes]`
- `tests/test_table_declaration.py::test_two_unique_columns_in_one_row_are_refused_naming_both`
- `tests/test_table_declaration.py::test_unique_on_a_nested_table_is_refused`
- `tests/test_table_declaration.py::test_unique_on_a_top_level_field_is_refused`
- `tests/test_table_declaration.py::test_unique_on_a_type_that_cannot_identify_a_row_is_refused[list of text-constraints4]`
- `tests/test_table_declaration.py::test_unique_on_a_type_that_cannot_identify_a_row_is_refused[multiple-choice-constraints2]`
- `tests/test_table_declaration.py::test_unique_on_a_type_that_cannot_identify_a_row_is_refused[paragraph-constraints0]`
- `tests/test_table_declaration.py::test_unique_on_a_type_that_cannot_identify_a_row_is_refused[secret-constraints3]`
- `tests/test_table_declaration.py::test_unique_on_a_type_that_cannot_identify_a_row_is_refused[switch-constraints1]`
- `tests/test_table_declaration.py::test_unique_is_accepted_on_each_comparable_type[choice]`
- `tests/test_table_declaration.py::test_unique_is_accepted_on_each_comparable_type[number]`
- `tests/test_table_declaration.py::test_unique_is_accepted_on_each_comparable_type[path]`
- `tests/test_table_declaration.py::test_unique_is_accepted_on_each_comparable_type[text]`
- `tests/test_table_drawing.py::test_a_table_column_draws_as_a_collapsible_group_under_the_row_that_holds_it`
- `tests/test_table_drawing.py::test_only_a_rows_first_columns_are_drawn_until_its_more_is_used`

### 5. Install and update a plugin from a git repository or a package index (PyPI)

- **Old app / now:** The person could point at a git repo (locked to a commit) or a package index and get install and update checks from there. Now only a signed catalogue archive or a local folder works.
- **Size:** L. Lives in: `adapters/fs/package-roots.ts` and `domain/packages/versions.ts`: new source kinds beside catalogue and folder; the installer would have to build a signed archive from the source.
- **Owner decision:** NO owner decision retires it. Closest owner words: "OK, official catalogue only" (docs/plans/0022-the-redesigned-application.md:696; docs/parity/owner-review.md:300), but those are about registering catalogue sources in the window, not about git or an index. The statement 'A package now comes only as a signed archive a catalogue names, or a folder a person chose' is the ledger's reason text (WI-0018-17), a plan author's. owner-review.md item 7 is 'Flag: no' with no owner words. The owner's recorded answer for the old app was the opposite: D15 "(c), any source a plugin declares, including git URLs. Git sources are locked to commit hashes." (docs/plans/0003-*.md:1888-1889).
- **Rows (10):**

- `tests/test_plugin_version_check.py::test_a_git_reference_is_locked_by_its_commit_hash`
- `tests/test_plugin_version_check.py::test_a_git_reference_that_is_not_a_commit_is_refused[monty @ git+https://forge.example.invalid/monty.git@aaaaaaa]`
- `tests/test_plugin_version_check.py::test_a_git_reference_that_is_not_a_commit_is_refused[monty @ git+https://forge.example.invalid/monty.git@main]`
- `tests/test_plugin_version_check.py::test_a_git_reference_that_is_not_a_commit_is_refused[monty @ git+https://forge.example.invalid/monty.git@v2.0.0]`
- `tests/test_plugin_version_check.py::test_a_git_reference_that_is_not_a_commit_is_refused[monty @ git+https://forge.example.invalid/monty.git]`
- `tests/test_plugin_version_check.py::test_a_git_release_tag_is_locked_as_its_commit_hash_and_never_as_the_tag`
- `tests/test_plugin_version_check.py::test_a_package_index_source_is_read_through_its_json_api`
- `tests/test_plugin_version_check.py::test_an_annotated_tag_resolves_to_its_peeled_commit`
- `tests/test_plugin_version_check.py::test_only_release_tags_newer_than_what_is_installed_are_read`
- `tests/test_plugin_version_check.py::test_the_manifest_is_read_from_the_repository_root_at_the_tag`

### 6. Update channels, strict versions, and 'needs a newer app' at check time

- **Old app / now:** A plugin author chose a stable or pre-release channel, a version like '*' or 'latest' was refused at install, and a newer version that needs a newer app was reported at check time. Now the catalogue offers one version, any version string installs, and a too-new package is refused only at Apply.
- **Size:** M. Lives in: `domain/packages/versions.ts` (ordering, refusal), the catalogue format (channel), `application/update-check.ts` (report protocol mismatch).
- **Owner decision:** none. owner-review.md lists 'Release channels' as Flag: YES and says the owner explicitly flagged it (the reason-code list after item 7), but records no decision.
- **Check:** UNSURE rows (newer version needing a newer app): run an update check against a catalogue entry whose protocol is above the app's and see whether the row says so before Apply.
- **Rows (11):**

- `tests/test_addon_manifest.py::test_a_version_that_is_not_an_exact_version_is_refused[*]`
- `tests/test_addon_manifest.py::test_a_version_that_is_not_an_exact_version_is_refused[>=1.0]`
- `tests/test_addon_manifest.py::test_a_version_that_is_not_an_exact_version_is_refused[]`
- `tests/test_addon_manifest.py::test_a_version_that_is_not_an_exact_version_is_refused[latest]`
- `tests/test_addon_manifest.py::test_an_update_channel_can_be_chosen`
- `tests/test_plugin_version_check.py::test_a_git_version_needing_a_newer_host_is_reported_with_rule_1` (UNSURE)
- `tests/test_plugin_version_check.py::test_a_named_index_entry_and_a_channel_are_both_honoured`
- `tests/test_plugin_version_check.py::test_a_package_index_prerelease_is_skipped_on_the_stable_channel`
- `tests/test_plugin_version_check.py::test_a_package_release_needing_a_newer_host_is_reported_with_rule_1` (UNSURE)
- `tests/test_plugin_version_check.py::test_a_published_version_needing_a_newer_host_is_reported_not_hidden` (UNSURE)
- `tests/test_plugin_version_check.py::test_rule_1_rejects_a_set_holding_a_version_this_host_cannot_run` (UNSURE)

### 7. Package-author workflow: live folder, editable install, replace in one step, reinstall

- **Old app / now:** An author could install a checkout so edits took effect on restart, replace an installed package in one step, and reinstall the same checkout. Now a folder install is a copy; changes need 'Check for changes', and removal is refused while a flow uses the package.
- **Size:** M. Lives in: `adapters/fs/package-roots.ts` and `shell/packages.ts` (a linked-folder install, a Replace action).
- **Owner decision:** none. Plan 0013's refusal of a changed declaration without a version bump is NOT an owner decision: plan 0013 is SUPERSEDED (docs/plans/0013-a-plugin-version-that-moved.md:5-12) by plan 0022 section F and WI-0022-19. Its only owner words are "the version of monty moved silently and the helper did not verify that it had" (a request for detection, not refusal). The refusal text is plan 0018's: "Plan 0013: a package whose content hash differs from the one recorded for the same version is refused and reported." (docs/plans/0018-the-new-application.md:839), approved under the owner's "proceed with the steps" (0018:16).
- **Check:** UNSURE rows (reinstall same checkout; changed declaration re-recorded): install a folder package, edit its reload-package.json without bumping the version, press Check for changes and read what the row says. The ledger promises 'refused and reported'.
- **Rows (7):**

- `tests/test_addon_discovery.py::test_a_recorded_source_is_read_back_whole`
- `tests/test_addons_cli.py::test_an_editable_install_points_the_environment_at_the_checkout`
- `tests/test_addons_cli.py::test_force_replaces_an_installation_that_came_from_another_source`
- `tests/test_addons_cli.py::test_force_replaces_the_installation_the_refusal_protected`
- `tests/test_addons_cli.py::test_reinstalling_the_same_checkout_needs_no_force` (UNSURE)
- `tests/test_plugin_environments.py::test_reinstalling_a_source_whose_manifest_changed_re_records_it` (UNSURE)
- `tests/test_plugin_environments.py::test_an_editable_install_locks_the_dependencies_and_not_the_addons_own_code`

### 8. Per-package update controls: Off, pin from the app, Update all

- **Old app / now:** A package could be set to Off (never checked), pinned from the app, and every manual package updated in one go. Now there is no Off, pin comes only from a settings import or a hand edit, and manual packages are applied one by one.
- **Size:** M. Lives in: `domain/update/policy.ts` (add off), `ui/screens` General › Packages (mode picker, Update all).
- **Owner decision:** none. owner-review.md flags 'Per-plugin off' and '"Update all" is gone' as YES, with no owner words.
- **Rows (6):**

- `tests/test_plugin_version_check.py::test_a_plugin_in_off_mode_is_never_checked`
- `tests/test_plugin_version_check.py::test_rule_4_rejects_a_set_that_moves_a_held_plugin[off]`
- `tests/test_helper_config.py::test_cli_addons_pin_and_unpin_round_trip`
- `tests/test_helper_config.py::test_cli_addons_pin_leaves_every_other_setting_alone`
- `tests/test_helper_config.py::test_cli_addons_pin_refuses_an_id_that_is_not_an_addon_id`
- `tests/test_plugin_update_apply.py::test_update_all_applies_every_addon_that_is_not_pinned`

### 9. Edit the stability numbers (restart attempts, delay, stop timeout, breaker window, check cadence, limits) in the app

- **Old app / now:** A Helper tab let the person edit the supervision numbers, validated and saved as a group, and a config file set the same. Now the six resource limits are editable in General › Advanced's Stability defaults form (plan 0031 A, `ui/screens/GeneralAdvanced.tsx` `LimitsForm`, saved as `limits` in `shell-settings.json`, each bad field refused in words, nothing written). Still fixed: the check cadence (10 s), the stop timeout, the restart attempts and backoff, and the breaker's window and count.
- **Size:** M. Lives in: `ui/screens/GeneralAdvanced.tsx` form and `adapters/fs/settings-store.ts` keys for restart attempts, delay, stop timeout, breaker window, sample interval; read by `domain/supervision/child-state.ts`.
- **Owner decision:** none. owner-review.md flags 'Helper supervision settings tab removed' as YES. docs/plans/0018-the-new-application.md:1166-1168 lists node-instance killing, rollback and the CLI as owner_ack items still to ask; that list is the plan author's, and plan 0031 later overruled it (0031:11).
- **Check:** Row 'Defaults differ': the crash-loop is 5 in 2 min (was 5 interventions in 10 min). The first-check spread (supervision branch) and resource limits (watchdog branch) are on branches; the crash-loop window is not.
- **Rows (15):**

- `tests/test_helper_config.py::test_every_documented_key_is_read_from_the_file`
- `tests/test_helper_config.py::test_the_default_numbers_are_the_plan_s_numbers`
- `tests/test_helper_tick.py::test_the_loop_reads_the_tick_interval_before_every_wait`
- `tests/test_helper_tick.py::test_the_running_loop_sleeps_the_cadence_the_user_configured`
- `tests/test_application_tab.py::test_helper_form_publishes_all_supervision_numbers`
- `tests/test_application_tab.py::test_helper_form_refuses_a_bad_number_without_touching_config`
- `tests/test_application_tab.py::test_helper_form_refuses_values_the_concrete_config_cannot_read[breaker_window-0]`
- `tests/test_application_tab.py::test_helper_form_refuses_values_the_concrete_config_cannot_read[max_children-2.5]`
- `tests/test_application_tab.py::test_helper_form_refuses_values_the_concrete_config_cannot_read[restart_attempts-1.5]`
- `tests/test_application_tab.py::test_helper_form_refuses_values_the_concrete_config_cannot_read[stop_timeout-0]`
- `tests/test_application_tab.py::test_helper_form_saves_through_live_helper_settings`
- `tests/test_toolkit_desktop.py::test_an_invalid_restart_delay_is_refused_without_crashing`
- `tests/test_toolkit_desktop.py::test_helper_draft_survives_switching_to_a_plugin_tab`
- `tests/test_toolkit_desktop.py::test_helper_fields_have_visible_labels_and_explanations`
- `tests/test_toolkit_desktop.py::test_numeric_lists_use_one_comma_separated_text_field`

### 10. Per-package terminal commands: list, start, stop, kill, restart, release

- **Old app / now:** From a terminal or script the person could list the running plugin processes, stop, kill or restart one, and release a quarantined one. Now there are only the whole-app commands (reload --status, --quit, --log) on the cli branch.
- **Size:** L. Lives in: `shell/command-line.ts` and `shell/command-answers.ts` (new verbs), `application/supervisor.ts` and `adapters/process/node-process.ts` (per-instance kill, restart, release).
- **Owner decision:** none. Plan 0031 group E names only status, quit and log (docs/plans/0031-the-features-the-old-app-had.md:40), so these are outside what was approved.
- **Rows (19):**

- `tests/test_control_channel.py::test_a_command_naming_a_child_the_host_does_not_have_is_refused_by_name`
- `tests/test_control_channel.py::test_a_command_the_host_cannot_read_ends_its_reader_rather_than_being_guessed_at[{"type": "command", "request": 1, "name": "start", "child_id": 7}-child_id is the child's name]`
- `tests/test_control_channel.py::test_every_command_plan_0003_defines_reaches_the_assembled_host_and_is_answered`
- `tests/test_control_channel.py::test_kill_reaches_the_host_and_the_child_is_killed_rather_than_asked`
- `tests/test_control_channel.py::test_list_answers_with_every_child_the_host_is_running`
- `tests/test_control_channel.py::test_start_reaches_the_host_and_answers_with_the_child_it_started`
- `tests/test_helper_breaker.py::test_helper_release_clears_the_quarantine_file`
- `tests/test_helper_restart.py::test_each_command_reaches_the_host_and_is_reported_back[<lambda>-kill]`
- `tests/test_helper_restart.py::test_each_command_reaches_the_host_and_is_reported_back[<lambda>-list]`
- `tests/test_helper_restart.py::test_each_command_reaches_the_host_and_is_reported_back[<lambda>-restart]`
- `tests/test_helper_restart.py::test_each_command_reaches_the_host_and_is_reported_back[<lambda>-start]`
- `tests/test_helper_restart.py::test_each_command_reaches_the_host_and_is_reported_back[<lambda>-stop]`
- `tests/test_host_children.py::test_a_command_naming_a_child_this_host_does_not_have_is_refused`
- `tests/test_host_children.py::test_a_command_that_names_no_child_at_all_is_refused`
- `tests/test_host_children.py::test_a_group_naming_a_child_this_host_does_not_have_is_refused`
- `tests/test_host_children.py::test_a_kill_command_kills_the_child_without_a_polite_stop`
- `tests/test_host_children.py::test_a_kill_command_kills_the_mcp_child_too`
- `tests/test_host_children.py::test_a_list_command_returns_every_live_child_with_its_identity`
- `tests/test_host_children.py::test_a_restart_command_spawns_the_child_exactly_once_more`

### 11. Bring Reload back after it crashes

- **Old app / now:** If the app itself crashed (segfault, abort) the old helper relaunched it. Now nothing relaunches it until the person opens it again.
- **Size:** M. Lives in: `shell/lifecycle.ts` and `shell/main.ts`: a small watcher process or an OS-level restart (LaunchAgent KeepAlive, systemd user unit, Windows task).
- **Owner decision:** none
- **Rows (5):**

- `tests/test_helper_launcher.py::test_the_host_relaunches_a_crashed_helper[ending0]`
- `tests/test_helper_launcher.py::test_the_host_relaunches_a_crashed_helper[ending1]`
- `tests/test_helper_launcher.py::test_the_host_relaunches_a_crashed_helper[ending2]`
- `tests/test_helper_launcher.py::test_the_host_relaunches_a_crashed_helper[ending3]`
- `tests/test_helper_launcher.py::test_the_host_relaunches_a_crashed_helper[ending4]`

### 12. Stop a node's child programs cleanly

- **Old app / now:** A model server or helper started by a node was asked politely to stop before being killed, was ended with the node on Windows too, and a process that survived a forced kill was named. Now it is killed outright, can outlive the node on Windows, and a survivor is not named. (`reload --quit` on the cli branch names surviving recorded processes, not a node's descendants.)
- **Size:** M. Lives in: `adapters/process/process-tree.ts` and `adapters/process/node-process.ts` (TERM, wait, KILL; a Windows Job Object).
- **Owner decision:** none
- **Check:** UNSURE rows (stopping runtime and services at once): quit while a flow is mid-write and see whether services stop before the runtime.
- **Rows (6):**

- `tests/test_helper_launcher.py::test_a_quit_stops_things_in_reverse_start_order` (UNSURE)
- `tests/test_helper_launcher.py::test_quit_order_is_the_reverse_of_the_start_order` (UNSURE)
- `tests/test_host_children.py::test_a_descendant_that_survives_a_forced_kill_is_named`
- `tests/test_host_children.py::test_a_descendant_that_survives_the_kill_comes_back_as_a_survivor`
- `tests/test_host_children.py::test_every_descendant_is_asked_politely_first`
- `tests/test_host_children.py::test_the_descendants_of_a_child_are_read_recursively`

### 13. A list of running processes with their state in the window

- **Old app / now:** The Application tab listed the host, the MCP server and each plugin as running, stopped or quarantined. Now only a banner shows trouble.
- **Size:** S. Lives in: `ui/screens/GeneralAdvanced.tsx` reading the cli branch's run-state (`shell/run-state.ts`).
- **Owner decision:** none
- **Check:** CHECK before building: docs/parity/owner-review.md ('Application tab / status') says a Status page already shows every supervised child's state; the audit says it does not. Open the window with a stopped plugin to settle it. The UNSURE row (every Application-tab group has a General counterpart) belongs to the settings audit.
- **Rows (2):**

- `tests/test_toolkit_desktop.py::test_the_grouped_application_tab_draws_every_shipped_group` (UNSURE)
- `tests/test_window_wiring.py::test_the_process_list_comes_from_the_run_state_file_and_the_quarantines`

### 14. Log detail: record each emitted event, and set verbosity in a setting

- **Old app / now:** The log recorded every event a plugin emitted (so an accepted event differs from a silent one) and verbosity was a stored setting. Now only refusals are logged and verbosity is an environment variable, hard to set for an app opened from the Dock.
- **Size:** S. Lives in: `adapters/process/node-process.ts` #onEmit (log accepted emits) and a log-level key in `adapters/fs/settings-store.ts` read by `shell/main.ts`.
- **Owner decision:** none
- **Rows (4):**

- `tests/test_logging.py::test_a_plugins_emit_is_recorded_from_inside_the_plugins_own_process`
- `tests/test_logging.py::test_an_accepted_event_and_a_refused_one_do_not_look_alike`
- `tests/test_logging.py::test_an_emitted_event_is_recorded`
- `tests/test_logging.py::test_the_verbosity_is_a_setting`

### 15. A package that needs another package, and saying why a step is held back (4 rows added from the re-audit: 'no package can require another' is the missing feature, not an internal change)

- **Old app / now:** A plugin could require another and was held back with the reason ('X is off'), and the summary named the field holding a step back. Now it simply runs without the other and the summary may not name the field.
- **Size:** M. Lives in: `domain/packages/declaration.ts` (requires), the hold reason in `domain/forms`, status wording in `application/supervisor.ts`.
- **Owner decision:** none. owner-review.md ('Held back for an unmet requirement') says no package requires another; that is the audit's description of the design, not owner words.
- **Check:** UNSURE rows (3): leave a required field empty and read the summary line; quarantine a node and read what the status says.
- **Rows (8):**

- `tests/test_enable_switch.py::test_a_hold_is_reported_with_the_field_that_causes_it` (UNSURE)
- `tests/test_enable_switch.py::test_a_missing_requirement_and_a_disabled_one_are_reported_in_the_same_shape` (UNSURE)
- `tests/test_enable_switch.py::test_a_plugin_that_requires_a_disabled_plugin_is_held_back_and_says_why`
- `tests/test_enable_switch.py::test_helper_status_says_disabled_held_and_quarantined_in_three_different_words` (UNSURE)
- `tests/test_host_children.py::test_an_addon_the_resolver_holds_back_is_never_spawned`
- `tests/test_addons_cli.py::test_up_names_an_addon_the_resolver_holds_back_and_never_spawns_it`
- `tests/test_addons_remove.py::test_a_plugin_another_one_requires_is_refused_by_name`
- `tests/test_plugin_page.py::test_a_plugin_another_one_requires_is_drawn_as_not_removable`

### 16. Read which Anytype tools exist, even with the MCP child down

- **Old app / now:** A read-only view of the Anytype tool list worked without the MCP child. Now it cannot be read.
- **Size:** S. Lives in: `application/anytype-service.ts` and the General › AI apps screen, from the recorded tool surface.
- **Owner decision:** none
- **Rows (2):**

- `tests/test_mcp_host_integration.py::test_the_tool_surface_is_readable_on_a_host_that_has_no_mcp_child`
- `tests/test_mcp_host_integration.py::test_the_tool_surface_is_readable_without_importing_the_mcp_package`

### 17. Developer tool to re-record the pinned Anytype MCP tool list and see what changed

- **Old app / now:** A developer bumping the pinned MCP server could re-record its tool list and see tools added or removed. Now the record is edited by hand.
- **Size:** M. Lives in: a script under `tools/` beside `app/test/fixtures` (developer-only, never shipped).
- **Owner decision:** none (not person-visible; a developer chore)
- **Rows (16):**

- `tests/test_anytype_mcp_tool_surface.py::test_refresh_against_a_missing_fixture_reports_every_tool_as_added`
- `tests/test_anytype_mcp_tool_surface.py::test_refresh_always_stops_the_child`
- `tests/test_anytype_mcp_tool_surface.py::test_refresh_completes_the_mcp_handshake_before_listing_tools`
- `tests/test_anytype_mcp_tool_surface.py::test_refresh_diffs_the_new_surface_against_the_recorded_one`
- `tests/test_anytype_mcp_tool_surface.py::test_refresh_ignores_output_that_is_not_its_answer`
- `tests/test_anytype_mcp_tool_surface.py::test_refresh_launches_the_exactly_pinned_package`
- `tests/test_anytype_mcp_tool_surface.py::test_refresh_records_what_the_server_listed`
- `tests/test_anytype_mcp_tool_surface.py::test_refresh_rejects_an_answer_that_carries_no_tool_list`
- `tests/test_anytype_mcp_tool_surface.py::test_refresh_rejects_an_answer_that_is_not_a_result_object`
- `tests/test_anytype_mcp_tool_surface.py::test_refresh_reports_a_server_error_instead_of_writing_a_surface`
- `tests/test_anytype_mcp_tool_surface.py::test_refresh_reports_a_server_that_answers_nothing`
- `tests/test_anytype_mcp_tool_surface.py::test_refresh_stops_the_child_even_when_it_fails`
- `tests/test_anytype_mcp_tool_surface.py::test_the_bundled_fixture_is_what_the_cli_would_rewrite`
- `tests/test_anytype_mcp_tool_surface.py::test_the_cli_prints_the_diff_it_recorded`
- `tests/test_anytype_mcp_tool_surface.py::test_the_cli_reports_an_unreachable_server_without_a_traceback`
- `tests/test_anytype_mcp_tool_surface.py::test_the_cli_says_when_the_surface_did_not_move`

### 18. A Reload release that changes the plugin/app API waits for the person's Apply

- **Old app / now:** A release that changed the API for plugins was held until the person applied it. Now it installs at the next quit like any other (only Go back, offered 7 days, remains).
- **Size:** M. Lives in: `shell/update.ts` and `domain/update/policy.ts`: mark a release incompatible and hold it; Apply in General.
- **Owner decision:** none for the new app. The old owner answer was D13 "(a), never automatic; always an explicit command." (docs/plans/0003-*.md:1880-1881); no later plan retires it.
- **Rows (6):**

- `tests/test_helper_core_update.py::test_a_host_api_change_still_waits_rather_than_being_handed_off`
- `tests/test_helper_core_update.py::test_a_release_that_is_not_automatic_waits_however_often_the_user_quits`
- `tests/test_helper_core_update.py::test_an_explicit_apply_installs_a_release_that_is_not_automatic`
- `tests/test_helper_notification.py::test_a_staged_release_that_waits_for_the_user_does_not_claim_a_quit_will_install_it`
- `tests/test_helper_update_check.py::test_a_new_host_api_major_is_never_automatic`
- `tests/test_window_wiring.py::test_a_release_waiting_in_staging_is_offered_and_applied_at_the_next_quit`

### 19. Re-check the staged update before installing it, and keep the working copy when an install fails

- **Old app / now:** The staged file was re-hashed at install and a failed install left the working copy alone. Now both are left to electron-updater.
- **Size:** S. Lives in: `shell/update.ts` (re-hash at quit) and an e2e.
- **Owner decision:** none
- **Check:** UNSURE rows (2): tamper with a staged download and quit; make an install fail and see whether the app still starts.
- **Rows (2):**

- `tests/test_helper_core_update.py::test_an_artifact_changed_since_it_was_staged_is_deleted_rather_than_installed` (UNSURE)
- `tests/test_helper_core_update.py::test_an_unpack_that_fails_leaves_the_installation_alone` (UNSURE)

### 20. Automatic rollback of a release that fails to start

- **Old app / now:** A new Reload that never started healthy was rolled back automatically with a notice naming it. Now the person is offered Go back for 7 days.
- **Size:** (decided). Lives in: n/a.
- **Owner decision:** YES, owner D4. "Ack as replaced by D4" (owner, 2026-10-02) (docs/plans/0022-the-redesigned-application.md:390; docs/parity/owner-review.md:352), and "D4 [old app's name] rollback: Go back installs the previous signed release, offered 7 days ... Owner: yes." (docs/plans/0022-the-redesigned-application.md:388-389). Recorded as acknowledged at docs/plans/0022-the-redesigned-application.md:695. This row (the rolled-back notice) was one of the 15 intended.
- **Rows (1):**

- `tests/test_helper_notification.py::test_a_rolled_back_update_names_the_update_that_rolled_back` (UNSURE)

### 21. Check packages still work before an app update, and do not restart the runtime for an idle package

- **Old app / now:** Before a Reload update the old app checked each installed plugin against the new version and named any that would break; updating a package that was not running touched nothing else. Now an app update installs without that check, and updating an idle package restarts the runtime and briefly stops other flows.
- **Size:** M. Lives in: `shell/update.ts` (compatibility check against installed protocol versions) and `application/update-package.ts` (skip the restart when no flow uses the package).
- **Owner decision:** none
- **Rows (5):**

- `tests/test_helper_core_update.py::test_a_compatible_plugin_does_not_stop_the_swap`
- `tests/test_helper_core_update.py::test_a_plugin_whose_manifest_cannot_be_read_does_not_hold_up_every_update`
- `tests/test_helper_core_update.py::test_an_incompatible_plugin_stops_the_swap_and_the_update_waits`
- `tests/test_helper_core_update.py::test_the_compatibility_check_names_every_plugin_that_would_stop`
- `tests/test_plugin_update_apply.py::test_update_of_an_addon_that_was_not_running_restarts_nothing`

### 22. Register a catalogue source from the app

- **Old app / now:** The Packages page could add, remove or switch a catalogue source. Now sources are written into `shell-settings.json` by hand or imported.
- **Size:** (decided). Lives in: n/a.
- **Owner decision:** YES, owner, 2026-10-15: "OK, official catalogue only" (docs/plans/0022-the-redesigned-application.md:696; docs/parity/owner-review.md:300). The ledger retired 12 rows with owner_ack yes; these 2 rows (a registered source round-trips) were missed in that batch.
- **Rows (2):**

- `tests/test_helper_config.py::test_a_registered_source_round_trips_through_the_config_file`
- `tests/test_helper_config.py::test_a_source_registered_with_nothing_optional_round_trips_too`

### 23. Refusals for hand-edited settings, and the Anytype key from the environment

- **Old app / now:** A package override under a name that is not a package id was refused naming it, a mistyped `mcp` key was refused, and ANYTYPE_API_KEY in the environment was used. Now the first two are silently ignored and the third is ignored.
- **Size:** S. Lives in: `adapters/fs/settings-store.ts` (validate keys) and the Anytype key reader in `adapters/anytype/`.
- **Owner decision:** none
- **Rows (3):**

- `tests/test_anytype_mcp_config.py::test_key_comes_from_the_environment_first`
- `tests/test_helper_config.py::test_a_plugin_table_named_by_something_that_is_not_an_id_is_refused`
- `tests/test_helper_config.py::test_the_mcp_section_refuses_a_shape_it_cannot_read[an unknown key]`

### 24. Change port when the services process is down

- **Old app / now:** The Settings page said the endpoint was unavailable. Now it shows only the generic failure line.
- **Size:** S. Lives in: `shell/service-calls.ts` and the General › AI apps message.
- **Owner decision:** none
- **Check:** UNSURE row: stop the services process, press Change, read the line.
- **Rows (1):**

- `tests/test_control_channel.py::test_an_endpoint_change_with_no_host_connected_is_named_rather_than_waited_out` (UNSURE)

### 25. Per-OS proofs: notices, shortcuts, icon, Windows update, Linux 16 px icon

- **Old app / now:** Reload's notices, the Windows icon, the Start-menu and desktop shortcuts (with the toast identity), and Windows self-update are not shown working on every OS.
- **Size:** M. Lives in: plan 0025 (Windows) and the plan 0031 proofs in `docs/parity/proofs.csv`; code in `app/src` only if a proof fails.
- **Owner decision:** none
- **Check:** ALL rows UNSURE: these are proofs, not absent features (Electron Notification and electron-builder NSIS exist). Each needs a run on that OS. Windows has no machine (docs/plans/0018-the-new-application.md section 11).
- **Rows (11):**

- `tests/test_bundle.py::test_the_macos_and_windows_icons_are_what_those_platforms_read` (UNSURE)
- `tests/test_helper_core_update.py::test_on_windows_the_swap_is_handed_to_a_launched_process_and_nothing_is_renamed` (UNSURE)
- `tests/test_helper_windows.py::test_both_shortcuts_are_generated_together_and_land_where_they_are_told` (UNSURE)
- `tests/test_helper_windows.py::test_the_desktop_shortcut_is_the_same_application_in_another_place` (UNSURE)
- `tests/test_helper_windows.py::test_the_start_menu_shortcut_names_the_helper_its_icon_and_the_application_id` (UNSURE)
- `tests/test_helper_notification.py::test_linux_has_a_notifier` (UNSURE)
- `tests/test_helper_notification.py::test_macos_has_a_notifier` (UNSURE)
- `tests/test_helper_windows.py::test_the_shortcut_carries_the_same_identifier_the_toast_is_raised_under` (UNSURE)
- `tests/test_helper_windows.py::test_windows_has_a_notifier_now_and_it_is_the_toast_one` (UNSURE)
- `tests/test_linux_support.py::test_the_real_backend_asks_notify_send_and_ties_it_to_the_desktop_entry` (UNSURE)
- `tests/test_bundle.py::test_the_icon_is_readable_at_sixteen_pixels`

### 26. A broken package declaration is refused at install, naming the field

- **Old app / now:** The old app refused a bad settings declaration (wrong-type default, empty choice list, min above max, unknown or misspelt attribute, duplicate name, a typo in a column three levels down) when the package loaded. Now the package installs and every node of the type is refused at start, or the mistake is silently ignored, so an author believes a rule is in force that is not.
- **Size:** M. Lives in: `domain/packages/declaration.ts` and the pack tool: a schema lint beside the ajv check in `adapters/nodered/registration.ts`.
- **Owner decision:** none
- **Rows (81):**

- `tests/test_addon_settings.py::test_a_bound_that_is_not_a_number_is_refused[max]`
- `tests/test_addon_settings.py::test_a_bound_that_is_not_a_number_is_refused[min]`
- `tests/test_addon_settings.py::test_a_bound_that_is_not_a_number_is_refused[step]`
- `tests/test_addon_settings.py::test_a_choice_without_options_is_refused[choice]`
- `tests/test_addon_settings.py::test_a_choice_without_options_is_refused[list of choice]`
- `tests/test_addon_settings.py::test_a_choice_without_options_is_refused[multiple-choice]`
- `tests/test_addon_settings.py::test_a_field_that_is_not_a_mapping_is_refused`
- `tests/test_addon_settings.py::test_a_label_that_is_not_a_string_is_refused[1]`
- `tests/test_addon_settings.py::test_a_label_that_is_not_a_string_is_refused[None]`
- `tests/test_addon_settings.py::test_a_label_that_is_not_a_string_is_refused[value2]`
- `tests/test_addon_settings.py::test_a_list_of_an_unrecognised_element_type_is_refused[list of Text]`
- `tests/test_addon_settings.py::test_a_list_of_an_unrecognised_element_type_is_refused[list of widget]`
- `tests/test_addon_settings.py::test_a_step_that_is_not_positive_is_refused[-1]`
- `tests/test_addon_settings.py::test_a_step_that_is_not_positive_is_refused[0]`
- `tests/test_addon_settings.py::test_a_type_outside_the_closed_vocabulary_is_refused[Text]`
- `tests/test_addon_settings.py::test_a_type_outside_the_closed_vocabulary_is_refused[]`
- `tests/test_addon_settings.py::test_a_type_outside_the_closed_vocabulary_is_refused[list of]`
- `tests/test_addon_settings.py::test_a_type_outside_the_closed_vocabulary_is_refused[list]`
- `tests/test_addon_settings.py::test_a_type_outside_the_closed_vocabulary_is_refused[widget]`
- `tests/test_addon_settings.py::test_a_type_that_is_not_a_string_is_refused`
- `tests/test_addon_settings.py::test_help_is_optional_and_must_be_a_string`
- `tests/test_addon_settings.py::test_options_that_are_not_a_list_of_distinct_names_are_refused[low]`
- `tests/test_addon_settings.py::test_options_that_are_not_a_list_of_distinct_names_are_refused[options0]`
- `tests/test_addon_settings.py::test_required_defaults_to_false_and_must_be_a_boolean`
- `tests/test_addon_settings.py::test_a_constraint_that_belongs_to_another_type_is_refused[choice-constraint4]`
- `tests/test_addon_settings.py::test_a_constraint_that_belongs_to_another_type_is_refused[switch-constraint3]`
- `tests/test_addon_settings.py::test_a_constraint_that_belongs_to_another_type_is_refused[text-constraint1]`
- `tests/test_addon_settings.py::test_a_constraint_that_belongs_to_another_type_is_refused[text-constraint2]`
- `tests/test_addon_settings.py::test_a_default_of_the_wrong_type_is_refused[field0-1]`
- `tests/test_addon_settings.py::test_a_default_of_the_wrong_type_is_refused[field1-True]`
- `tests/test_addon_settings.py::test_a_default_of_the_wrong_type_is_refused[field2-5]`
- `tests/test_addon_settings.py::test_a_default_of_the_wrong_type_is_refused[field3-True]`
- `tests/test_addon_settings.py::test_a_default_of_the_wrong_type_is_refused[field4-yes]`
- `tests/test_addon_settings.py::test_a_default_of_the_wrong_type_is_refused[field5-1]`
- `tests/test_addon_settings.py::test_a_default_of_the_wrong_type_is_refused[field6-1]`
- `tests/test_addon_settings.py::test_a_default_of_the_wrong_type_is_refused[field7-one]`
- `tests/test_addon_settings.py::test_a_default_of_the_wrong_type_is_refused[field8-wav]`
- `tests/test_addon_settings.py::test_a_default_outside_a_number_s_bounds_is_refused[0]`
- `tests/test_addon_settings.py::test_a_default_outside_a_number_s_bounds_is_refused[11]`
- `tests/test_addon_settings.py::test_a_default_that_is_not_one_of_the_options_is_refused`
- `tests/test_addon_settings.py::test_a_field_missing_one_of_the_three_required_attributes_is_refused[label]`
- `tests/test_addon_settings.py::test_a_field_missing_one_of_the_three_required_attributes_is_refused[type]`
- `tests/test_addon_settings.py::test_a_list_default_with_a_bad_element_is_refused`
- `tests/test_addon_settings.py::test_a_list_of_an_unrecognised_element_type_is_refused[list of list of text]`
- `tests/test_addon_settings.py::test_a_multiple_choice_default_repeating_an_option_is_refused`
- `tests/test_addon_settings.py::test_a_null_default_is_refused`
- `tests/test_addon_settings.py::test_a_number_whose_minimum_exceeds_its_maximum_is_refused`
- `tests/test_addon_settings.py::test_an_empty_id_is_refused`
- `tests/test_addon_settings.py::test_an_empty_label_is_refused`
- `tests/test_addon_settings.py::test_an_unknown_field_attribute_is_refused`
- `tests/test_addon_settings.py::test_options_that_are_not_a_list_of_distinct_names_are_refused[options2]`
- `tests/test_addon_settings.py::test_options_that_are_not_a_list_of_distinct_names_are_refused[options3]`
- `tests/test_addon_settings.py::test_options_that_are_not_a_list_of_distinct_names_are_refused[options4]`
- `tests/test_addon_settings.py::test_two_fields_sharing_an_id_are_refused`
- `tests/test_table_declaration.py::test_a_default_row_carrying_an_undeclared_key_is_refused`
- `tests/test_table_declaration.py::test_a_default_row_in_a_nested_table_is_named_by_its_own_row_label`
- `tests/test_table_declaration.py::test_a_default_row_missing_a_required_column_is_refused`
- `tests/test_table_declaration.py::test_a_default_row_that_is_not_a_mapping_is_refused`
- `tests/test_table_declaration.py::test_a_default_row_whose_value_fails_a_column_s_constraint_is_refused`
- `tests/test_table_declaration.py::test_a_list_of_tables_is_refused`
- `tests/test_table_declaration.py::test_a_refusal_three_levels_down_names_the_whole_path_to_the_column`
- `tests/test_table_declaration.py::test_a_row_field_missing_its_id_type_or_label_is_refused_by_position`
- `tests/test_table_declaration.py::test_a_row_field_of_a_type_outside_the_closed_vocabulary_is_refused[Text]`
- `tests/test_table_declaration.py::test_a_row_field_of_a_type_outside_the_closed_vocabulary_is_refused[]`
- `tests/test_table_declaration.py::test_a_row_field_of_a_type_outside_the_closed_vocabulary_is_refused[list of widget]`
- `tests/test_table_declaration.py::test_a_row_field_of_a_type_outside_the_closed_vocabulary_is_refused[widget]`
- `tests/test_table_declaration.py::test_a_row_field_s_default_is_judged_against_its_own_constraints`
- `tests/test_table_declaration.py::test_a_row_that_is_not_a_list_of_fields_is_refused[1]`
- `tests/test_table_declaration.py::test_a_row_that_is_not_a_list_of_fields_is_refused[label]`
- `tests/test_table_declaration.py::test_a_row_that_is_not_a_list_of_fields_is_refused[row1]`
- `tests/test_table_declaration.py::test_a_row_that_repeats_a_field_id_is_refused_naming_the_row_and_the_field`
- `tests/test_table_declaration.py::test_a_table_default_that_is_not_a_list_of_rows_is_refused[1]`
- `tests/test_table_declaration.py::test_a_table_default_that_is_not_a_list_of_rows_is_refused[Zoom H6]`
- `tests/test_table_declaration.py::test_a_table_default_that_is_not_a_list_of_rows_is_refused[default1]`
- `tests/test_table_declaration.py::test_a_table_missing_row_or_row_label_is_refused_by_name[row]`
- `tests/test_table_declaration.py::test_a_table_missing_row_or_row_label_is_refused_by_name[row_label]`
- `tests/test_table_declaration.py::test_an_empty_row_is_refused`
- `tests/test_table_declaration.py::test_an_empty_table_default_is_refused`
- `tests/test_table_declaration.py::test_an_unknown_attribute_on_a_row_field_is_refused`
- `tests/test_table_declaration.py::test_row_and_row_label_on_a_field_that_is_not_a_table_are_refused[row]`
- `tests/test_table_declaration.py::test_row_and_row_label_on_a_field_that_is_not_a_table_are_refused[row_label]`

### 27. The form shows the reason beside the field, and empty required values are caught

- **Old app / now:** Each field and each table cell showed its own error, a required text, secret or table left empty was flagged on its field, and a row holding a key the declaration dropped was reported on that row. Now the reason is text under the whole form or only in the node's validation errors, and an empty required value is accepted.
- **Size:** M. Lives in: `ui` editor form and `domain/forms/form-model.ts`; `adapters/nodered/coerce.ts` (empty string against `required`).
- **Owner decision:** none
- **Rows (20):**

- `tests/test_plugin_page.py::test_a_refused_value_is_drawn_with_its_reason_beside_it`
- `tests/test_settings_form.py::test_a_required_secret_that_is_not_set_holds_the_plugin_and_names_the_field`
- `tests/test_settings_form.py::test_an_error_from_a_failed_save_stays_beside_the_field_until_it_is_corrected`
- `tests/test_settings_form.py::test_each_field_carries_its_value_its_default_and_its_error`
- `tests/test_settings_store.py::test_a_required_field_with_no_default_yields_no_value`
- `tests/test_table_drawing.py::test_a_cells_reason_is_drawn_beside_that_cell_and_nowhere_else`
- `tests/test_table_drawing.py::test_the_tables_own_reason_is_drawn_once_above_the_whole_table`
- `tests/test_table_drawing.py::test_the_two_reasons_are_placed_independently`
- `tests/test_table_form.py::test_a_cell_error_is_reachable_by_its_rows_position_and_its_fields_id`
- `tests/test_table_form.py::test_a_missing_required_cell_is_addressed_to_the_cell_that_is_missing`
- `tests/test_table_form.py::test_a_nested_cell_error_is_addressed_by_the_path_down_to_it`
- `tests/test_table_form.py::test_a_nested_row_publishes_its_own_rows_and_its_own_cell_errors_at_depth_three`
- `tests/test_table_form.py::test_a_required_table_with_no_rows_says_so_above_the_table`
- `tests/test_table_form.py::test_a_row_carrying_a_key_the_declaration_does_not_name_is_the_rows_own_error`
- `tests/test_table_store.py::test_a_required_cell_missing_from_one_row_refuses_only_that_row`
- `tests/test_table_store.py::test_a_required_nested_table_with_no_rows_refuses_its_row`
- `tests/test_table_store.py::test_a_required_table_clears_its_hold_the_moment_one_valid_row_is_written`
- `tests/test_table_store.py::test_a_required_table_whose_every_row_is_refused_is_held_rather_than_half_recorded`
- `tests/test_table_store.py::test_a_row_carrying_a_key_the_declaration_does_not_name_is_refused`
- `tests/test_table_store.py::test_a_write_that_empties_a_required_table_holds_the_plugin_disabled`

### 28. [DATA] A bad entry is no longer kept out: good fields and rows survive, the old value stays

- **Old app / now:** Saving with one bad field recorded the good fields and kept the old value of the bad one; a bad added row was left out, a bad edit kept the previous row, and nested rows likewise. Now the bad value is saved over the good one and the whole node stops, so a good row can be lost.
- **Size:** M. Lives in: `adapters/nodered/registration.ts` (judge per field/row before writing) and the editor form.
- **Owner decision:** none
- **Rows (14):**

- `tests/test_plugin_tab.py::test_save_routes_the_whole_working_copy_and_refusal_writes_nothing`
- `tests/test_settings_form.py::test_a_field_that_fails_does_not_stop_the_fields_that_pass`
- `tests/test_settings_store.py::test_a_write_of_only_invalid_fields_touches_nothing`
- `tests/test_settings_store.py::test_a_write_records_the_valid_field_and_refuses_only_the_invalid_one`
- `tests/test_table_drawing.py::test_a_cell_behind_the_more_is_not_emptied_by_a_save`
- `tests/test_table_form.py::test_a_refused_rows_submitted_values_are_published_beside_its_error`
- `tests/test_table_store.py::test_a_column_default_fills_a_cell_the_row_leaves_out`
- `tests/test_table_store.py::test_a_nested_row_added_to_a_row_that_had_none_has_nothing_to_fall_back_on`
- `tests/test_table_store.py::test_a_nested_table_cell_that_is_not_a_list_refuses_its_row`
- `tests/test_table_store.py::test_a_refused_nested_row_keeps_the_nested_row_previously_on_disk`
- `tests/test_table_store.py::test_a_refused_row_deep_in_a_nested_table_refuses_only_itself`
- `tests/test_table_store.py::test_a_write_of_three_new_rows_records_the_two_that_pass`
- `tests/test_table_store.py::test_an_added_row_that_fails_is_absent_rather_than_partly_recorded`
- `tests/test_table_store.py::test_an_edited_row_that_fails_keeps_the_row_previously_on_disk`

### 29. A broken package is shown, not hidden

- **Old app / now:** A package whose install record could not be read, or whose record named another package, appeared in the Packages list as broken with a reason and a Remove. Now it vanishes from the list, or stands in for the real package, with a log line blaming another one.
- **Size:** M. Lives in: `adapters/fs/package-roots.ts` list() (lines 247-284 per the audit) and the Packages board.
- **Owner decision:** none
- **Check:** UNSURE rows (2, a package tab's parts: version, source, held detail, switch, Save/Cancel/Remove, pending update): compare Reload's package board part by part.
- **Rows (11):**

- `tests/test_plugin_tab.py::test_a_fully_described_plugin_tab_carries_every_part` (UNSURE)
- `tests/test_table_drawing.py::test_the_deeper_level_is_drawn_indented_under_the_row_it_belongs_to` (UNSURE)
- `tests/test_addon_discovery.py::test_a_source_record_that_cannot_be_read_breaks_the_addon_it_belongs_to[["/home/someone/git/monty"]-is not a source record]`
- `tests/test_addon_discovery.py::test_a_source_record_that_cannot_be_read_breaks_the_addon_it_belongs_to[{ not json-could not be read]`
- `tests/test_addon_discovery.py::test_a_source_record_that_cannot_be_read_breaks_the_addon_it_belongs_to[{"path": "", "editable": true}-is malformed]`
- `tests/test_addon_discovery.py::test_a_source_record_that_cannot_be_read_breaks_the_addon_it_belongs_to[{"path": "/git/monty", "editable": "yes"}-is malformed]`
- `tests/test_addon_discovery.py::test_a_source_record_that_cannot_be_read_breaks_the_addon_it_belongs_to[{"path": "/git/monty", "editable": false, "extra": 1}-is not a source record]`
- `tests/test_addon_discovery.py::test_a_source_record_that_cannot_be_read_breaks_the_addon_it_belongs_to[{"path": "/git/monty"}-is not a source record]`
- `tests/test_addon_discovery.py::test_a_manifest_claiming_another_id_is_reported`
- `tests/test_plugin_tab.py::test_broken_plugin_has_detail_and_remove_but_no_form`
- `tests/test_tab_model.py::test_a_broken_plugin_gets_a_tab_carrying_its_reason`

### 30. [DATA] A broken settings or flows file is refused, not emptied and overwritten

- **Old app / now:** A hand-broken settings file was refused by name. Now a flows.json that is not valid JSON makes Node-RED warn and start with empty flows, and the next deploy writes over the person's flows. A settings file that is not UTF-8 is read with bad bytes replaced.
- **Size:** S. Lives in: `adapters/nodered/settings.ts` / storage module (refuse to start on an unreadable flows file); `adapters/fs/settings-store.ts` (strict UTF-8).
- **Owner decision:** none. IN PROGRESS on `fix/flows-file-refused` (~/git/reload-hotfix): at the time of this audit the branch has no commits or changes beyond main, so nothing is counted as covered.
- **Rows (3):**

- `tests/test_settings_store.py::test_a_file_that_is_not_utf8_is_refused_by_name`
- `tests/test_settings_store.py::test_a_file_that_is_not_valid_toml_is_refused_by_name`
- `tests/test_helper_config.py::test_a_file_that_is_not_utf8_is_refused`

### 31. [DATA] A value for a setting the plugin stopped declaring is dropped at the next deploy

- **Old app / now:** A value kept for a setting that a plugin later stopped declaring came back when the setting returned. Now it is dropped at the next deploy.
- **Size:** S. Lives in: `adapters/nodered/coerce.ts` / editor export (keep undeclared keys).
- **Owner decision:** none
- **Rows (1):**

- `tests/test_settings_store.py::test_a_value_recorded_for_a_field_nobody_declares_any_more_is_kept`

### 32. [SAFETY] Inputs held for a stuck node have no limit

- **Old app / now:** Every queue was capped and a slow consumer was cut off. Now inputs to a node that stops finishing pile up in the runtime's memory without a limit (one log line).
- **Size:** M. Lives in: `adapters/process/input-journal.ts` (the in-memory held list) with a bound and a notice.
- **Owner decision:** none
- **Rows (4):**

- `tests/test_event_bus.py::test_a_subscriber_that_falls_behind_is_dropped_at_its_bound`
- `tests/test_event_bus.py::test_the_queue_never_grows_past_the_bound`
- `tests/test_event_transport.py::test_a_subscriber_that_is_never_drained_stops_at_the_bound_and_is_dropped[cross-process]`
- `tests/test_event_transport.py::test_a_subscriber_that_is_never_drained_stops_at_the_bound_and_is_dropped[in-process]`

### 33. [SAFETY] Node processes left behind after a runtime crash

- **Old app / now:** After a crash the old helper asked leftover plugin processes to stop, then killed them, before relaunching. Now a stubborn node process of a crashed runtime keeps running beside the restarted one.
- **Size:** M. Lives in: `application/supervisor.ts` before relaunch plus `adapters/process/process-tree.ts` (record pids, stop them).
- **Owner decision:** none
- **Rows (2):**

- `tests/test_helper_process_identity.py::test_an_orphan_is_asked_politely_before_it_is_killed`
- `tests/test_helper_process_identity.py::test_every_orphan_is_stopped_before_the_host_is_relaunched`

### 34. [SAFETY] A kill sent to a process id after the process has exited

- **Old app / now:** The old app checked a process's identity before signalling it. Now a kill is sent to a node process's PID after it exited (on Windows to the bare PID), so a reused PID could take down an unrelated program.
- **Size:** S. Lives in: `adapters/process/exit-watch.ts:34-39` and `process-tree.ts:41-49`.
- **Owner decision:** none
- **Rows (1):**

- `tests/test_host_children.py::test_stopping_a_child_that_has_already_died_signals_nothing`

### 35. [SAFETY] The login item stays registered when macOS asks for approval

- **Old app / now:** A refused load left no half-registered login item. Now the switch reads off but the login item stays registered, so approving it later in System Settings makes Reload start at login while the switch says off.
- **Size:** S. Lives in: `application/launch-at-login.ts:44-51` (unregister on refusal).
- **Owner decision:** none
- **Rows (1):**

- `tests/test_macos.py::test_a_load_that_fails_leaves_no_half_registered_login_item`

### 36. Update offers and notices that are not true

- **Old app / now:** An archive with a different version from its catalogue entry, or an entry
  naming a newer version with no archive, was not offered; the 'ready, installs when you quit'
  notice came only after staging. Now the same: neither is offered, and the notice comes only once
  the release is staged.
- **Size:** S. Lives in: `application/update-check.ts`, `application/package-catalogues.ts`.
- **Owner decision:** none; the default is Port (the standing rule above), and it is ported.
- **Ported (port/0032-small-safety):** the "ready, installs when you quit" notice comes only once
  staging has completed. An entry naming a newer version but no archive is not offered. A newer
  version is offered only once its archive has been downloaded, its signature verified, and its
  declaration found to name that package at that version; otherwise the page says why.
- **Cost, in plain words:** each new release of an installed package is downloaded once (up to
  256 MB), when a check first sees it: not on every check, every refresh of the Packages page or
  every launch, since the verdict is kept on disk; a refused release is not downloaded again until
  its catalogue entry changes. One archive file per package is kept, overwritten by the next
  release, deleted when refused and once installed, so a catalogue that keeps bumping its
  versions cannot grow the disk. Apply installs that same file, verified again, or downloads it
  afresh if it no longer verifies. Downloading it tells the catalogue's host that this machine has
  the package installed and has seen the new version, as Apply always did, only earlier.
- **Left as it was:** an install of a new package and "Install again" (a repair) still swap their
  folder in before the runtime restarts, not while it is stopped. A new package has no old
  instances to close; a repair is refused unless its content is byte for byte what is live, so the
  closing instances read the same files either way.
- **Rows (3):**

- `tests/test_plugin_version_check.py::test_a_git_manifest_that_disagrees_with_its_tag_is_not_offered`
- `tests/test_plugin_version_check.py::test_a_package_release_that_cannot_be_judged_is_not_offered[release_files0-release_document0-a release with no files left]`
- `tests/test_helper_notification.py::test_a_staged_release_is_announced_once_staging_completes`

### 37. Saving one setting restarts every node in every flow

- **Old app / now:** Changing one node's value restarted only that plugin. Now the full deploy restarts every Reload node process.
- **Size:** M. Lives in: `adapters/electron/editor-frame.ts:88-93` (deploy type 'nodes'/'flows') or per-node restart in `adapters/process/node-process.ts`.
- **Owner decision:** none
- **Rows (2):**

- `tests/test_addon_settings_runtime.py::test_a_changed_value_restarts_its_plugin_and_costs_it_nothing`
- `tests/test_window_wiring.py::test_a_saved_setting_reaches_the_store_and_restarts_that_plugin`

### 38. Show what the runtime refused, and open the right place from a notice

- **Old app / now:** A kind the host refused was drawn in the window, and clicking a notice about a stopped step or package selected it. Now the reason goes to the log only, and a click only brings the window forward.
- **Size:** S. Lives in: `domain/notices/notices.ts` and `shell/lifecycle.ts` notice click.
- **Owner decision:** none
- **Rows (2):**

- `tests/test_window_wiring.py::test_a_kind_the_host_refused_is_drawn_on_that_plugins_tab`
- `tests/test_window_wiring.py::test_notification_click_selects_its_plugin_or_the_application`

### 39. 'See what would be sent' shows the exact body that will be posted

- **Old app / now:** The preview was byte for byte what the transport posted (D24). Now it shows the payload without the envelope, release and website id added at send time.
- **Size:** S. Lives in: `shell/telemetry.ts:137` and `domain/telemetry/transports.ts`.
- **Owner decision:** none (D24 is the old owner answer; plan 0003:1916 'letting the user see what is sent')
- **Rows (1):**

- `tests/test_helper_telemetry.py::test_what_show_prints_is_byte_for_byte_what_the_transport_posts`

### 40. [SAFETY] Unproven: no secret in a shown reason; an old package version sees only its own files while closing

- **Old app / now:** Two safety properties of the old app are not proven in Reload: that a reason shown to the person never carries the Anytype key or MCP token, and that a package's old version sees only its own files while it is asked to close during an update.
- **Size:** S. Lives in: tests in `app/test/` (runtime-output secret scan; update-package swap order).
- **Owner decision:** none
- **Check:** ALL rows UNSURE: write the test; `update-package.ts:355-362` swaps files into the live folder while old processes still run.
- **Rows (2):**

- `tests/test_mcp_host_integration.py::test_no_credential_reaches_the_helper_in_what_the_host_came_up_without` (UNSURE)
- `tests/test_plugin_update_apply.py::test_the_plugin_is_still_on_its_old_version_when_the_stop_arrives` (UNSURE)

## Covered by open branches

### port/0031-watchdog (~/git/reload-watchdog)

Memory, CPU over a window, open files, children, grace window, polite stop then kill, limits per type in `reload.limits`, defaults under `limits` in `shell-settings.json`. NOT in the diff: a window form for the defaults (file only); Windows is not measured; CPU stops a process (the plan text says so).

Rows (7):

- `tests/test_helper_config.py::test_helper_wide_stability_defaults_are_the_manifest_s_numbers`
- `tests/test_helper_windows.py::test_a_process_that_counts_neither_is_refused_rather_than_measured_as_zero`
- `tests/test_helper_windows.py::test_a_windows_process_reads_into_the_same_resource_sample_every_slice_consumes`
- `tests/test_helper_windows.py::test_open_files_are_handles_on_windows_and_descriptors_everywhere_else`
- `tests/test_linux_support.py::test_the_existing_process_table_reads_linux_resources_without_a_second_implementation`
- `tests/test_helper_detection.py::test_a_phantom_record_is_never_sampled_and_never_signalled`
- `tests/test_helper_detection.py::test_the_real_process_table_measures_this_interpreter`

### port/0031-supervision (~/git/reload-cutover)

`reload.heartbeat` {interval_s, stale_after_s} with ping/pong, health and a progress marker; `reload.restartable`; `check_jitter` on the update check; an unreachable Anytype not retried on a timer. The 14 manifest rows (stability fields) are covered by `reload.heartbeat` and `restartable` here plus `reload.limits` on the watchdog branch. PARTIAL: the runtime and services processes are not pinged, only node types that declare a heartbeat. UNSURE row (a child that fails at start): the branch's 'never started costs no attempt' tests should settle it.

Rows (21):

- `tests/test_addon_manifest.py::test_a_non_positive_count_is_refused`
- `tests/test_addon_manifest.py::test_a_stability_count_that_is_not_an_integer_is_refused`
- `tests/test_addon_manifest.py::test_a_stability_limit_that_is_not_positive_is_refused[-1]`
- `tests/test_addon_manifest.py::test_a_stability_limit_that_is_not_positive_is_refused[0]`
- `tests/test_addon_manifest.py::test_a_stability_number_that_is_not_a_number_is_refused[10]`
- `tests/test_addon_manifest.py::test_a_stability_number_that_is_not_a_number_is_refused[None]`
- `tests/test_addon_manifest.py::test_a_stability_number_that_is_not_a_number_is_refused[True]`
- `tests/test_addon_manifest.py::test_a_stability_section_parses_with_the_plans_defaults`
- `tests/test_addon_manifest.py::test_a_stability_section_that_is_not_a_mapping_is_refused`
- `tests/test_addon_manifest.py::test_a_stale_window_without_heartbeats_is_refused`
- `tests/test_addon_manifest.py::test_an_empty_stability_section_promises_no_heartbeats`
- `tests/test_addon_manifest.py::test_an_unknown_stability_field_is_refused`
- `tests/test_addon_manifest.py::test_every_stability_field_can_be_set`
- `tests/test_addon_manifest.py::test_restartable_must_be_a_boolean`
- `tests/test_control_channel.py::test_a_command_the_host_never_answers_is_named_silence_and_makes_it_stale`
- `tests/test_helper_heartbeat.py::test_a_beat_from_a_process_nobody_registered_is_still_watched`
- `tests/test_helper_heartbeat.py::test_a_complete_heartbeat_makes_the_round_trip`
- `tests/test_helper_heartbeat.py::test_several_processes_beat_over_their_own_connections`
- `tests/test_helper_heartbeat.py::test_the_socket_fills_the_registry`
- `tests/test_helper_launcher.py::test_a_child_that_never_started_reaches_the_policy_and_is_not_restarted` (UNSURE)
- `tests/test_helper_tick.py::test_a_stale_host_is_stopped_before_it_is_started_again`

### port/0031-cli-log (~/git/reload-cli)

`reload --status`, `--quit`, `--quit --force`, `--log`, the run-state file, Show log in General › Advanced. `--status` answers from run-state and notices files when nothing runs. NOT in the diff: per-package verbs (group 10), a verbosity setting (group 14).

Rows (7):

- `tests/test_helper_notification.py::test_a_notices_file_that_cannot_be_read_is_read_as_nothing`
- `tests/test_helper_notification.py::test_a_notices_file_written_by_a_newer_helper_keeps_the_lines_this_one_understands`
- `tests/test_helper_notification.py::test_a_quarantine_is_not_reported_twice_by_status`
- `tests/test_helper_notification.py::test_status_reports_every_update_condition_in_the_words_of_the_notification`
- `tests/test_helper_notification.py::test_status_says_so_when_no_update_is_waiting`
- `tests/test_helper_launcher.py::test_force_quit_stops_every_recorded_process_without_asking_anyone`
- `tests/test_helper_notification.py::test_status_reports_a_quarantine_and_a_staged_update_with_no_notification_ever_shown` (UNSURE)

### telemetry-signals (~/git/reload-telemetry)

Step failures are sent with error_type, file and line as usage signals. PARTIAL: plan 0029 says crash reports 'still go nowhere (D23)' (docs/plans/0029-telemetry-signals.md:114 on that branch) because there is no error-report DSN, while the old row asked for type-and-frames error reports. UNSURE row: decide whether step-error signals satisfy it.

Rows (1):

- `tests/test_helper_telemetry.py::test_an_error_report_carries_the_type_and_the_frames_but_never_the_message` (UNSURE)

## Rows I think were wrongly called missing

Removing a package. A flow's stored credentials belong to the flow's nodes, and the owner's D6 refuses unregistering a package while any flow uses it: "Yes, but the package must then warn explicitly which flow is using it" (docs/plans/0022-the-redesigned-application.md:393-395). So no credential in use is orphaned. What remains to check is the per-node data folder of nodes already deleted (`dataDirFor` in `adapters/nodered/registration.ts`). Rows:

- `tests/test_addons_remove.py::test_a_secrets_directory_holding_a_subdirectory_keeps_it`
- `tests/test_addons_remove.py::test_reinstalling_starts_from_the_declarations_defaults`
- `tests/test_plugin_secrets.py::test_removing_a_plugin_removes_every_secret_it_had` (UNSURE)

Softer, left in their groups: the notice rows in group 25 are proofs of an existing Electron feature, and the four 'version is not exact' rows in group 6 differ only in when the refusal happens (install versus update check).
