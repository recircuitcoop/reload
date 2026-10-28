// The clients Reload can connect, one file adapter each (plan 0033 §B and §F).

import type { AiAppConnections, AiAppId } from "../../ports/ai-app-connections";
import { ClaudeConfigConnections } from "./claude-config-file";
import { CodexConfigConnections } from "./codex-config-file";

/** Every client Reload can connect, over the home and the command search path it is given. */
export function fileAiAppConnections(
  home: string,
  platform: NodeJS.Platform,
  searchPath: string | undefined,
): Readonly<Record<AiAppId, AiAppConnections>> {
  return {
    codex: new CodexConfigConnections(home, platform),
    claude: new ClaudeConfigConnections(home, platform, searchPath),
  };
}
