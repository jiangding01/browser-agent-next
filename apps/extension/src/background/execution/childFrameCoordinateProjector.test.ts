import {
  describe,
  expect,
  it,
} from "vitest";
import type {
  FrameState,
} from "@browser-agent-next/core";
import {
  ChildFrameCoordinateProjector,
} from "./childFrameCoordinateProjector.js";

const singleFrames: FrameState[] = [
  {
    frameId: "web:0",
    documentEpoch: "chrome-document:main",
    accessible: true,
  },
  {
    frameId: "web:2",
    parentFrameId: "web:0",
    documentEpoch: "chrome-document:child",
    accessible: true,
  },
];

function singleBindings() {
  return {
    bindingForFrame(
      _tabId: number,
      frameId: string,
    ) {
      if (frameId === "web:0") {
        return {
          frameEpoch: "epoch-main",
          cdpFrameId: "cdp-main",
          documentEpoch:
            "chrome-document:main",
        };
      }
      if (frameId === "web:2") {
        return {
          frameEpoch: "epoch-child",
          cdpFrameId: "cdp-child",
          cdpSessionId:
            "session-child",
          documentEpoch:
            "chrome-document:child",
        };
      }
      return undefined;
    },
  };
}

describe(
  "ChildFrameCoordinateProjector",
  () => {
    it(
      "把 OOPIF local point 投影到 root content quad 并执行 root owner hit-test",
      async () => {
        const calls: string[] = [];
        const transport = {
          contextBindingsForFrame(
            _tabId: number,
            cdpFrameId: string,
          ) {
            if (
              cdpFrameId ===
              "cdp-child"
            ) {
              return [{
                sessionId:
                  "session-child",
                context: {
                  id: 22,
                  auxData: {
                    frameId:
                      "cdp-child",
                    isDefault: false,
                  },
                },
              }];
            }
            return [{
              context: {
                id: 11,
                auxData: {
                  frameId:
                    "cdp-main",
                  isDefault: false,
                },
              },
            }];
          },
          async send(
            _tabId: number,
            method: string,
            params: Record<
              string,
              unknown
            >,
          ) {
            calls.push(
              "root:" + method,
            );
            if (
              method ===
              "Runtime.evaluate"
            ) {
              return {
                result: {
                  value: {
                    width: 1000,
                    height: 800,
                  },
                },
              };
            }
            if (
              method ===
              "DOM.getFrameOwner"
            ) {
              expect(params).toEqual({
                frameId:
                  "cdp-child",
              });
              return {
                backendNodeId: 500,
              };
            }
            if (
              method ===
              "DOM.getBoxModel"
            ) {
              return {
                model: {
                  content: [
                    100, 50,
                    300, 50,
                    300, 150,
                    100, 150,
                  ],
                },
              };
            }
            if (
              method ===
              "DOM.resolveNode"
            ) {
              return {
                object: {
                  objectId:
                    "owner-root",
                },
              };
            }
            if (
              method ===
              "Runtime.callFunctionOn"
            ) {
              return {
                result: {
                  value: true,
                },
              };
            }
            return {
              result: {},
            };
          },
          async sendInSession(
            _tabId: number,
            sessionId: string,
            method: string,
          ) {
            calls.push(
              sessionId + ":" + method,
            );
            if (
              method ===
              "Runtime.evaluate"
            ) {
              return {
                result: {
                  value: {
                    width: 200,
                    height: 100,
                  },
                },
              };
            }
            return {
              result: {},
            };
          },
        };

        const projector =
          new ChildFrameCoordinateProjector(
            transport as never,
            singleBindings(),
          );

        await expect(
          projector.project({
            tabId: 7,
            targetFrameId:
              "web:2",
            point: {
              x: 50,
              y: 25,
            },
            frames: singleFrames,
          }),
        ).resolves.toEqual({
          ok: true,
          point: {
            x: 150,
            y: 75,
          },
          rootFrameOwnerBackendNodeId:
            500,
        });

        expect(calls).toContain(
          "session-child:Runtime.evaluate",
        );
        expect(calls).toContain(
          "root:DOM.getFrameOwner",
        );
        expect(calls).toContain(
          "root:Runtime.callFunctionOn",
        );
      },
    );

    it(
      "nested frame 逐层按各自 viewport/content quad 投影",
      async () => {
        const frames: FrameState[] = [
          {
            frameId: "web:0",
            documentEpoch: "doc-main",
            accessible: true,
          },
          {
            frameId: "web:2",
            parentFrameId: "web:0",
            documentEpoch: "doc-parent",
            accessible: true,
          },
          {
            frameId: "web:4",
            parentFrameId: "web:2",
            documentEpoch: "doc-child",
            accessible: true,
          },
        ];

        const bindings = {
          bindingForFrame(
            _tabId: number,
            frameId: string,
          ) {
            const values =
              frameId === "web:0"
                ? {
                    frameEpoch:
                      "epoch-main",
                    cdpFrameId:
                      "cdp-main",
                    documentEpoch:
                      "doc-main",
                  }
                : frameId === "web:2"
                  ? {
                      frameEpoch:
                        "epoch-parent",
                      cdpFrameId:
                        "cdp-parent",
                      cdpSessionId:
                        "session-parent",
                      documentEpoch:
                        "doc-parent",
                    }
                  : frameId === "web:4"
                    ? {
                        frameEpoch:
                          "epoch-child",
                        cdpFrameId:
                          "cdp-child",
                        cdpSessionId:
                          "session-child",
                        documentEpoch:
                          "doc-child",
                      }
                    : undefined;
            return values;
          },
        };

        const hitTests: string[] = [];
        let allowIntermediateHit = true;

        const transport = {
          contextBindingsForFrame(
            _tabId: number,
            cdpFrameId: string,
          ) {
            const config =
              cdpFrameId ===
              "cdp-main"
                ? {
                    id: 10,
                    sessionId:
                      undefined,
                  }
                : cdpFrameId ===
                    "cdp-parent"
                  ? {
                      id: 20,
                      sessionId:
                        "session-parent",
                    }
                  : {
                      id: 30,
                      sessionId:
                        "session-child",
                    };
            return [{
              ...(config.sessionId
                ? {
                    sessionId:
                      config.sessionId,
                  }
                : {}),
              context: {
                id: config.id,
                auxData: {
                  frameId:
                    cdpFrameId,
                  isDefault: false,
                },
              },
            }];
          },
          async send(
            _tabId: number,
            method: string,
            params: any,
          ) {
            if (
              method ===
              "Runtime.evaluate"
            ) {
              return {
                result: {
                  value: {
                    width: 1000,
                    height: 800,
                  },
                },
              };
            }
            if (
              method ===
              "DOM.getFrameOwner"
            ) {
              expect(params.frameId)
                .toBe(
                  "cdp-parent",
                );
              return {
                backendNodeId: 500,
              };
            }
            if (
              method ===
              "DOM.getBoxModel"
            ) {
              return {
                model: {
                  content: [
                    100, 100,
                    500, 100,
                    500, 300,
                    100, 300,
                  ],
                },
              };
            }
            if (
              method ===
              "DOM.resolveNode"
            ) {
              return {
                object: {
                  objectId:
                    "outer-owner",
                },
              };
            }
            if (
              method ===
              "Runtime.callFunctionOn"
            ) {
              hitTests.push("root");
              return {
                result: {
                  value: true,
                },
              };
            }
            return {
              result: {},
            };
          },
          async sendInSession(
            _tabId: number,
            sessionId: string,
            method: string,
            params: any,
          ) {
            if (
              method ===
              "Runtime.evaluate"
            ) {
              return {
                result: {
                  value:
                    sessionId ===
                    "session-child"
                      ? {
                          width: 100,
                          height: 100,
                        }
                      : {
                          width: 400,
                          height: 200,
                        },
                },
              };
            }
            if (
              sessionId ===
                "session-parent" &&
              method ===
                "DOM.getFrameOwner"
            ) {
              expect(params.frameId)
                .toBe(
                  "cdp-child",
                );
              return {
                backendNodeId: 600,
              };
            }
            if (
              sessionId ===
                "session-parent" &&
              method ===
                "DOM.getBoxModel"
            ) {
              return {
                model: {
                  content: [
                    10, 20,
                    210, 20,
                    210, 120,
                    10, 120,
                  ],
                },
              };
            }
            if (
              sessionId ===
                "session-parent" &&
              method ===
                "DOM.resolveNode"
            ) {
              return {
                object: {
                  objectId:
                    "inner-owner",
                },
              };
            }
            if (
              sessionId ===
                "session-parent" &&
              method ===
                "Runtime.callFunctionOn"
            ) {
              hitTests.push(
                "session-parent",
              );
              return {
                result: {
                  value:
                    allowIntermediateHit,
                },
              };
            }
            return {
              result: {},
            };
          },
        };

        const projector =
          new ChildFrameCoordinateProjector(
            transport as never,
            bindings,
          );

        await expect(
          projector.project({
            tabId: 7,
            targetFrameId:
              "web:4",
            point: {
              x: 25,
              y: 50,
            },
            frames,
          }),
        ).resolves.toEqual({
          ok: true,
          point: {
            x: 160,
            y: 170,
          },
          rootFrameOwnerBackendNodeId:
            500,
        });

        expect(hitTests).toEqual([
          "session-parent",
          "root",
        ]);

        allowIntermediateHit = false;
        hitTests.length = 0;

        await expect(
          projector.project({
            tabId: 7,
            targetFrameId:
              "web:4",
            point: {
              x: 25,
              y: 50,
            },
            frames,
          }),
        ).resolves.toMatchObject({
          ok: false,
          reason:
            "parent hit-test no longer reaches the projected frame owner",
        });

        expect(hitTests).toEqual([
          "session-parent",
        ]);
      },
    );

    it(
      "2D affine transform content quad 按实时 quad 正确投影",
      async () => {
        const transport = {
          contextBindingsForFrame(
            _tabId: number,
            cdpFrameId: string,
          ) {
            return [{
              ...(cdpFrameId ===
              "cdp-child"
                ? {
                    sessionId:
                      "session-child",
                  }
                : {}),
              context: {
                id: 1,
                auxData: {
                  frameId:
                    cdpFrameId,
                  isDefault: false,
                },
              },
            }];
          },
          async send(
            _tabId: number,
            method: string,
          ) {
            if (
              method ===
              "DOM.getFrameOwner"
            ) {
              return {
                backendNodeId: 500,
              };
            }
            if (
              method ===
              "DOM.getBoxModel"
            ) {
              return {
                model: {
                  // 200x100 viewport 经过 90° 旋转 +
                  // 平移后的 affine content quad。
                  content: [
                    300, 100,
                    300, 300,
                    200, 300,
                    200, 100,
                  ],
                },
              };
            }
            if (
              method ===
              "DOM.resolveNode"
            ) {
              return {
                object: {
                  objectId:
                    "owner-root",
                },
              };
            }
            if (
              method ===
              "Runtime.callFunctionOn"
            ) {
              return {
                result: {
                  value: true,
                },
              };
            }
            return {
              result: {
                value: {
                  width: 1000,
                  height: 800,
                },
              },
            };
          },
          async sendInSession() {
            return {
              result: {
                value: {
                  width: 200,
                  height: 100,
                },
              },
            };
          },
        };

        await expect(
          new ChildFrameCoordinateProjector(
            transport as never,
            singleBindings(),
          ).project({
            tabId: 7,
            targetFrameId:
              "web:2",
            point: {
              x: 50,
              y: 25,
            },
            frames: singleFrames,
          }),
        ).resolves.toEqual({
          ok: true,
          point: {
            x: 275,
            y: 150,
          },
          rootFrameOwnerBackendNodeId:
            500,
        });
      },
    );

    it(
      "连续 prepare 使用最新 frame owner box model，不复用 scroll 前坐标",
      async () => {
        let boxLeft = 100;

        const transport = {
          contextBindingsForFrame(
            _tabId: number,
            cdpFrameId: string,
          ) {
            return [{
              ...(cdpFrameId ===
              "cdp-child"
                ? {
                    sessionId:
                      "session-child",
                  }
                : {}),
              context: {
                id: 1,
                auxData: {
                  frameId:
                    cdpFrameId,
                  isDefault: false,
                },
              },
            }];
          },
          async send(
            _tabId: number,
            method: string,
          ) {
            if (
              method ===
              "DOM.getFrameOwner"
            ) {
              return {
                backendNodeId: 500,
              };
            }
            if (
              method ===
              "DOM.getBoxModel"
            ) {
              return {
                model: {
                  content: [
                    boxLeft, 50,
                    boxLeft + 200, 50,
                    boxLeft + 200, 150,
                    boxLeft, 150,
                  ],
                },
              };
            }
            if (
              method ===
              "DOM.resolveNode"
            ) {
              return {
                object: {
                  objectId:
                    "owner-root",
                },
              };
            }
            if (
              method ===
              "Runtime.callFunctionOn"
            ) {
              return {
                result: {
                  value: true,
                },
              };
            }
            return {
              result: {
                value: {
                  width: 1000,
                  height: 800,
                },
              },
            };
          },
          async sendInSession() {
            return {
              result: {
                value: {
                  width: 200,
                  height: 100,
                },
              },
            };
          },
        };

        const projector =
          new ChildFrameCoordinateProjector(
            transport as never,
            singleBindings(),
          );

        const first =
          await projector.project({
            tabId: 7,
            targetFrameId:
              "web:2",
            point: {
              x: 50,
              y: 25,
            },
            frames: singleFrames,
          });

        boxLeft = 20;

        const second =
          await projector.project({
            tabId: 7,
            targetFrameId:
              "web:2",
            point: {
              x: 50,
              y: 25,
            },
            frames: singleFrames,
          });

        expect(first).toMatchObject({
          ok: true,
          point: {
            x: 150,
            y: 75,
          },
        });
        expect(second).toMatchObject({
          ok: true,
          point: {
            x: 70,
            y: 75,
          },
        });
      },
    );

    it(
      "透视/非 affine content quad 直接 fail closed",
      async () => {
        const transport = {
          contextBindingsForFrame(
            _tabId: number,
            cdpFrameId: string,
          ) {
            return [{
              ...(cdpFrameId ===
              "cdp-child"
                ? {
                    sessionId:
                      "session-child",
                  }
                : {}),
              context: {
                id: 1,
                auxData: {
                  frameId:
                    cdpFrameId,
                  isDefault: false,
                },
              },
            }];
          },
          async send(
            _tabId: number,
            method: string,
          ) {
            if (
              method ===
              "DOM.getFrameOwner"
            ) {
              return {
                backendNodeId: 500,
              };
            }
            if (
              method ===
              "DOM.getBoxModel"
            ) {
              return {
                model: {
                  content: [
                    100, 50,
                    300, 40,
                    320, 170,
                    90, 150,
                  ],
                },
              };
            }
            return {
              result: {
                value: {
                  width: 1000,
                  height: 800,
                },
              },
            };
          },
          async sendInSession() {
            return {
              result: {
                value: {
                  width: 200,
                  height: 100,
                },
              },
            };
          },
        };

        const result =
          await new ChildFrameCoordinateProjector(
            transport as never,
            singleBindings(),
          ).project({
            tabId: 7,
            targetFrameId:
              "web:2",
            point: {
              x: 50,
              y: 25,
            },
            frames: singleFrames,
          });

        expect(result).toMatchObject({
          ok: false,
          reason:
            "frame owner content quad is not affine; perspective projection is unsupported",
        });
      },
    );

    it(
      "stale document binding 在任何 CDP projection command 前拒绝",
      async () => {
        let commandCount = 0;
        const result =
          await new ChildFrameCoordinateProjector(
            {
              contextBindingsForFrame() {
                commandCount += 1;
                return [];
              },
            } as never,
            {
              bindingForFrame(
                _tabId: number,
                frameId: string,
              ) {
                if (
                  frameId === "web:2"
                ) {
                  return {
                    frameEpoch:
                      "epoch-child",
                    cdpFrameId:
                      "cdp-child",
                    cdpSessionId:
                      "session-child",
                    documentEpoch:
                      "STALE",
                  };
                }
                return {
                  frameEpoch:
                    "epoch-main",
                  cdpFrameId:
                    "cdp-main",
                  documentEpoch:
                    "chrome-document:main",
                };
              },
            },
          ).project({
            tabId: 7,
            targetFrameId:
              "web:2",
            point: {
              x: 50,
              y: 25,
            },
            frames: singleFrames,
          });

        expect(result).toMatchObject({
          ok: false,
          reason:
            "projection chain document binding is stale",
        });
        expect(commandCount).toBe(0);
      },
    );

    it(
      "任一 parent owner hit-test 失败时不返回 projected target",
      async () => {
        const transport = {
          contextBindingsForFrame(
            _tabId: number,
            cdpFrameId: string,
          ) {
            return [{
              ...(cdpFrameId ===
              "cdp-child"
                ? {
                    sessionId:
                      "session-child",
                  }
                : {}),
              context: {
                id: 1,
                auxData: {
                  frameId:
                    cdpFrameId,
                  isDefault: false,
                },
              },
            }];
          },
          async send(
            _tabId: number,
            method: string,
          ) {
            if (
              method ===
              "DOM.getFrameOwner"
            ) {
              return {
                backendNodeId: 500,
              };
            }
            if (
              method ===
              "DOM.getBoxModel"
            ) {
              return {
                model: {
                  content: [
                    100, 50,
                    300, 50,
                    300, 150,
                    100, 150,
                  ],
                },
              };
            }
            if (
              method ===
              "DOM.resolveNode"
            ) {
              return {
                object: {
                  objectId:
                    "owner-root",
                },
              };
            }
            if (
              method ===
              "Runtime.callFunctionOn"
            ) {
              return {
                result: {
                  value: false,
                },
              };
            }
            return {
              result: {
                value: {
                  width: 1000,
                  height: 800,
                },
              },
            };
          },
          async sendInSession() {
            return {
              result: {
                value: {
                  width: 200,
                  height: 100,
                },
              },
            };
          },
        };

        const result =
          await new ChildFrameCoordinateProjector(
            transport as never,
            singleBindings(),
          ).project({
            tabId: 7,
            targetFrameId:
              "web:2",
            point: {
              x: 50,
              y: 25,
            },
            frames: singleFrames,
          });

        expect(result).toMatchObject({
          ok: false,
          reason:
            "parent hit-test no longer reaches the projected frame owner",
        });
      },
    );
  },
);
