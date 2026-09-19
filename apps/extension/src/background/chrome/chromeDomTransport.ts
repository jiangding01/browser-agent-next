import {
  isObserveDomFrameResponse,
  type ObserveDomFrameRequest,
  type ObserveDomFrameResponse,
} from "../../protocol/perception.js";
import type {
  DomFrameTarget,
  DomFrameTransport,
} from "../perception/domCollector.js";

export interface ChromeTabsMessagingApi {
  sendMessage(
    tabId: number,
    message: unknown,
    options: {
      frameId?: number;
      documentId?: string;
    },
  ): Promise<unknown>;
}

export class ChromeDomFrameTransport implements DomFrameTransport {
  constructor(private readonly tabs: ChromeTabsMessagingApi) {}

  async send(
    tabId: number,
    target: DomFrameTarget,
    request: ObserveDomFrameRequest,
  ): Promise<ObserveDomFrameResponse> {
    const options = target.documentId
      ? { documentId: target.documentId }
      : { frameId: target.transportFrameId };

    const raw = await this.tabs.sendMessage(
      tabId,
      request,
      options,
    );

    if (!isObserveDomFrameResponse(raw)) {
      throw new Error("content script returned an invalid DOM perception response");
    }
    if (raw.requestId !== request.requestId) {
      throw new Error("content script response requestId does not match request");
    }

    return raw;
  }
}
