import {
  describe,
  expect,
  it,
} from "vitest";
import {
  registerOperatorApprovalUiIngress,
} from "./operatorApprovalIngress.js";

function setup() {
  let listener: any;
  const responses: any[] = [];
  const calls: string[] = [];

  const runtime = {
    id: "extension-id",
    getURL(path: string) {
      return (
        "chrome-extension://extension-id/" +
        path
      );
    },
    onMessage: {
      addListener(next: any) {
        listener = next;
      },
      removeListener() {},
    },
  };

  const approvals = {
    listPending() {
      calls.push("list");
      return [];
    },
    approve(id: string) {
      calls.push(
        "approve:" + id,
      );
      return {
        grant: {
          id: "auth",
        },
      };
    },
    reject(id: string) {
      calls.push(
        "reject:" + id,
      );
      return {
        approvalRequestId: id,
      };
    },
  };

  registerOperatorApprovalUiIngress(
    runtime as never,
    approvals as never,
  );

  return {
    listener,
    responses,
    calls,
  };
}

describe(
  "registerOperatorApprovalUiIngress",
  () => {
    it(
      "只接受精确 operator approval page sender",
      () => {
        const {
          listener,
          responses,
          calls,
        } = setup();

        const sendResponse = (
          value: unknown,
        ) =>
          responses.push(value);

        const message = {
          type:
            "operator-approval.approve",
          requestId: "req-1",
          approvalRequestId:
            "operator-1",
        };

        listener(
          message,
          {
            id: "extension-id",
            url:
              "https://page.test/",
          },
          sendResponse,
        );

        listener(
          message,
          {
            id:
              "other-extension",
            url:
              "chrome-extension://extension-id/operator-approval.html",
          },
          sendResponse,
        );

        expect(calls)
          .toEqual([]);

        expect(responses)
          .toEqual([]);

        listener(
          message,
          {
            id: "extension-id",
            url:
              "chrome-extension://extension-id/operator-approval.html",
          },
          sendResponse,
        );

        expect(calls)
          .toEqual([
            "approve:operator-1",
          ]);

        expect(
          responses[0],
        ).toMatchObject({
          ok: true,
          requestId: "req-1",
        });
      },
    );

    it(
      "未知字段不能借 UI ingress 进入审批逻辑",
      () => {
        const {
          listener,
          responses,
          calls,
        } = setup();

        listener(
          {
            type:
              "operator-approval.approve",
            requestId: "req-1",
            approvalRequestId:
              "operator-1",
            assurance:
              "enterprise-policy",
          },
          {
            id: "extension-id",
            url:
              "chrome-extension://extension-id/operator-approval.html",
          },
          (value: unknown) =>
            responses.push(value),
        );

        expect(calls)
          .toEqual([]);

        expect(responses)
          .toEqual([]);
      },
    );
  },
);
