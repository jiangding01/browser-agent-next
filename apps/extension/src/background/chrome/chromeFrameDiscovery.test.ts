import { describe, expect, it } from "vitest";
import {
  discoverChromeDomFrames,
  sameChromeDocumentCatalog,
  type ChromeDomFrameCatalog,
} from "./chromeFrameDiscovery.js";

describe("discoverChromeDomFrames", () => {
  it("uses Chrome documentId as document identity", async () => {
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

    expect(result.mainDocumentEpoch).toBe("chrome-document:doc-main");
    expect(result.mainUrl).toBe("https://example.test/");
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

  it("detects document or frame topology changes across collection", () => {
    const stable: ChromeDomFrameCatalog = {
      frames: [],
      domFrames: [
        {
          frameId: "web:0",
          transportFrameId: 0,
          documentId: "doc-main",
          accessible: true,
        },
        {
          frameId: "web:7",
          transportFrameId: 7,
          documentId: "doc-child",
          accessible: true,
        },
      ],
      mainFrameId: "web:0",
      mainDocumentEpoch: "chrome-document:doc-main",
      mainUrl: "https://example.test/",
    };

    expect(sameChromeDocumentCatalog(stable, {
      ...stable,
      domFrames: stable.domFrames.map((frame) => ({ ...frame })),
    })).toBe(true);

    expect(sameChromeDocumentCatalog(stable, {
      ...stable,
      domFrames: stable.domFrames.map((frame) =>
        frame.frameId === "web:7"
          ? { ...frame, documentId: "doc-child-new" }
          : frame,
      ),
    })).toBe(false);

    expect(sameChromeDocumentCatalog(stable, {
      ...stable,
      domFrames: stable.domFrames.slice(0, 1),
    })).toBe(false);
  });
});
