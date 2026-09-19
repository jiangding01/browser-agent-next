export interface BackgroundMessageSender {
  id?: string;
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
