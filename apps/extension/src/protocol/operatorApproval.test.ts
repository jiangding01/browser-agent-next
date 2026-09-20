import {
  describe,
  expect,
  it,
} from "vitest";
import {
  isOperatorApprovalUiRequest,
} from "./operatorApproval.js";

describe(
  "isOperatorApprovalUiRequest",
  () => {
    it(
      "只接受有界 exact-key 请求",
      () => {
        expect(
          isOperatorApprovalUiRequest({
            type:
              "operator-approval.approve",
            requestId: "r",
            approvalRequestId: "a",
          }),
        ).toBe(true);

        expect(
          isOperatorApprovalUiRequest({
            type:
              "operator-approval.approve",
            requestId: "r",
            approvalRequestId: "a",
            assurance:
              "enterprise-policy",
          }),
        ).toBe(false);

        expect(
          isOperatorApprovalUiRequest({
            type:
              "operator-approval.approve",
            requestId: "r",
            approvalRequestId:
              "x".repeat(257),
          }),
        ).toBe(false);
      },
    );
  },
);
