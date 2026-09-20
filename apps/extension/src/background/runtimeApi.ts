export interface BackgroundMessageSender {
  id?: string;
  tab?: {
    id?: number;
  };
  frameId?: number;
  documentId?: string;
}

export interface BackgroundRuntimeMessageEvent {
  addListener(
    listener: (
      message: unknown,
      sender: BackgroundMessageSender,
      sendResponse: (response: any) => void,
    ) => boolean | void,
  ): void;
  removeListener(
    listener: (
      message: unknown,
      sender: BackgroundMessageSender,
      sendResponse: (response: any) => void,
    ) => boolean | void,
  ): void;
}

export interface ExtensionBackgroundRuntimeApi {
  id: string;
  onMessage: BackgroundRuntimeMessageEvent;
}
