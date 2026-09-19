import { describe, expect, it } from "vitest";
import { discoverChromeDomFrames } from "./chromeFrameDiscovery.js";

describe("discoverChromeDomFrames", () => {
  it("uses Chrome documentId as the document epoch and keeps transport ids separate", async () => {
    const result = await discoverChromeDomFrames(
      {
        async getAllFrames() {
          return [
            {
              frameId: 0,
              parentFrameId: -1,
              url: "https://example.test/",
              documentId: "doc-main",
            },
            {
              frameId: 7,
              parentFrameId: 0,
              url: "https://child.test/",
              documentId: "doc-child",
            },
          ];
        },
      },
      11,
    );

    expect(result.mainFrameId).toBe("web:0");
    expect(result.mainDocumentEpoch).toBe("chrome-document:doc-main");
    expect(result.frames[1]).toMatchObject({
      frameId: "web:7",
      parentFrameId: "web:0",
      documentEpoch: "chrome-document:doc-child",
    });
    expect(result.domFrames[1]).toMatchObject({
      frameId: "web:7",
      transportFrameId: 7,
      documentId: "doc-child",
    });
  });

  it("fails closed if main document identity is unavailable", async () => {
    await expect(
      discoverChromeDomFrames(
        {
          async getAllFrames() {
            return [{
              frameId: 0,
              parentFrameId: -1,
              url: "https://example.test/",
            }];
          },
        },
        1,
      ),
    ).rejects.toThrow(/documentId/);
  });
});
