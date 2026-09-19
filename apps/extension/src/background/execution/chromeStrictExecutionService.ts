import type { StoredObservationStrictCoordinator } from "@browser-agent-next/runtime";
import type { PreparedStrictClickTarget } from "./chromeStrictClickResolver.js";

export class ChromeStrictExecutionService {
  constructor(
    private readonly coordinator:
      StoredObservationStrictCoordinator<PreparedStrictClickTarget>,
  ) {}

  async prepareClick(input: {
    tabId: number;
    actionId: string;
    observedRevision: string;
    ref: string;
  }): Promise<PreparedStrictClickTarget> {
    const prepared = await this.coordinator.prepare(
      input.tabId,
      {
        actionId: input.actionId,
        kind: "click",
        observedRevision: input.observedRevision,
        target: { ref: input.ref },
      },
    );

    return prepared.prepared;
  }
}
