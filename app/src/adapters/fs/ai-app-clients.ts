// The clients Reload can connect, one file adapter each (plan 0033 §B; WI-0033-10 adds Claude).

import type { AiAppConnections, AiAppId } from "../../ports/ai-app-connections";
import { CodexConfigConnections } from "./codex-config-file";

/** Every client Reload can connect, over the home it is given. */
export function fileAiAppConnections(
  home: string,
  platform: NodeJS.Platform,
): Readonly<Record<AiAppId, AiAppConnections>> {
  return { codex: new CodexConfigConnections(home, platform) };
}
