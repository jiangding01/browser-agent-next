import {
  InMemoryAuthorizationStore,
  MutableExactOriginAllowlist,
} from "@browser-agent-next/policy";
import { InMemoryPersistentRefStore } from "@browser-agent-next/refs";
import {
  StoredObservationStrictCoordinator,
  TabOwnershipRegistry,
  TabRevisionRegistry,
  TabStateStore,
} from "@browser-agent-next/runtime";
import {
  type BackgroundRuntimeApi,
  registerObserveTabBackgroundListener,
} from "./perception/backgroundListener.js";
import {
  registerStrictExecutionBackgroundListener,
} from "./execution/backgroundListener.js";
import {
  bindAuthorizationLifecycle,
} from "./execution/authorizationLifecycle.js";
import {
  ChromeStrictClickDispatcher,
} from "./execution/chromeStrictClickDispatcher.js";
import {
  ChildFrameCoordinateProjector,
} from "./execution/childFrameCoordinateProjector.js";
import {
  ChromeStrictExecutionService,
} from "./execution/chromeStrictExecutionService.js";
import {
  ChromeStrictMainFrameClickResolver,
} from "./execution/chromeStrictClickResolver.js";
import {
  PolicyGatedStrictClickExecutor,
} from "./execution/policyGatedStrictClick.js";
import {
  createRootPresentationFence,
} from "./execution/rootPresentationFence.js";
import {
  TrustedHostExecutionService,
} from "./execution/trustedHostExecutionService.js";
import {
  StrictClickAuthorizationIssuanceService,
} from "./execution/authorizationIssuanceService.js";
import {
  connectTrustedNativeIngress,
  type TrustedNativeRuntimeApi,
} from "./execution/trustedNativeIngress.js";
import {
  OperatorApprovalStore,
} from "./execution/operatorApprovalStore.js";
import {
  registerOperatorApprovalUiIngress,
  type OperatorApprovalRuntimeApi,
} from "./execution/operatorApprovalIngress.js";
import {
  ChromeManagedEnterpriseAuthorizationPolicyProvider,
  type ManagedStorageArea,
} from "./execution/enterpriseManagedPolicy.js";
import {
  ChromeStorageEnterpriseAssertionReplayStore,
  type WritableStorageArea,
} from "./execution/enterpriseAssertionReplayStore.js";
import {
  EnterprisePolicyAuthorizationService,
} from "./execution/enterprisePolicyAuthorizationService.js";
import {
  type ChromeLifecycleApi,
  bindChromeDomLifecycle,
} from "./chrome/chromeLifecycleBinding.js";
import {
  ChromeDomObservationService,
  type ChromeTabsApi,
} from "./chrome/chromeObservationService.js";
import {
  ChromeDebuggerReadTransport,
  type ChromeDebuggerApi,
} from "./chrome/chromeDebuggerTransport.js";
import type { ChromeWebNavigationApi } from "./chrome/chromeFrameDiscovery.js";
import { DomLifecycleRegistry } from "./chrome/domLifecycleRegistry.js";
import {
  IsolatedWorldDomIdentityResolver,
} from "./perception/domAxCorrespondence.js";
import {
  IsolatedWorldDomStableIdInspector,
} from "./perception/domStableIdInspector.js";
import { DomObservationCoordinator } from "./perception/observationCoordinator.js";
import { HighLevelBrowserApiService } from "./api/browserApiService.js";
import {
  type ApprovalBadgeActionApi,
  bindOperatorApprovalBadge,
} from "./execution/approvalBadge.js";
import {
  IsolatedWorldStrictActionRunner,
} from "./execution/chromeStrictIsolatedActions.js";
import {
  BrowserChangeSignalHub,
  registerBrowserChangeSignals,
} from "./api/browserChangeSignalHub.js";

interface ChromeBackgroundApi extends ChromeLifecycleApi {
  runtime:
    & BackgroundRuntimeApi
    & TrustedNativeRuntimeApi
    & { readonly id: string };
  debugger: ChromeDebuggerApi;
  action: ApprovalBadgeActionApi;
  tabs:
    & ChromeLifecycleApi["tabs"]
    & ChromeTabsApi
    & {
      create(input: {
        url: string;
        active?: boolean;
      }): Promise<{
        id?: number;
        url?: string;
      }>;
    };
  webNavigation:
    & ChromeLifecycleApi["webNavigation"]
    & ChromeWebNavigationApi;
  storage: {
    managed: ManagedStorageArea;
    local: WritableStorageArea;
  };
}

declare const chrome: ChromeBackgroundApi;

function runtimeEpoch(): string {
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(
      bytes,
      (byte) => byte.toString(36).padStart(2, "0"),
    ).join("");
  } catch {
    return (
      "runtime-" +
      Math.random().toString(36).slice(2) +
      Date.now().toString(36)
    );
  }
}

const refs = new InMemoryPersistentRefStore();
const states = new TabStateStore();
const revisions = new TabRevisionRegistry(runtimeEpoch());
const lifecycle = new DomLifecycleRegistry(refs, states);
const tabOwnership = new TabOwnershipRegistry();
const browserChangeSignals = new BrowserChangeSignalHub();

const coordinator = new DomObservationCoordinator(
  refs,
  revisions,
  states,
  lifecycle,
);

const debuggerTransport =
  new ChromeDebuggerReadTransport(chrome.debugger);

const identityResolver =
  new IsolatedWorldDomIdentityResolver(debuggerTransport);

const domInspector =
  new IsolatedWorldDomStableIdInspector(debuggerTransport);

const perceptionService = new ChromeDomObservationService(
  chrome.tabs,
  chrome.webNavigation,
  coordinator,
  debuggerTransport,
);

const childCoordinateProjector =
  new ChildFrameCoordinateProjector(
    debuggerTransport,
    lifecycle,
  );

const strictResolver =
  new ChromeStrictMainFrameClickResolver(
    refs,
    chrome.webNavigation,
    debuggerTransport,
    identityResolver,
    domInspector,
    lifecycle,
    childCoordinateProjector,
  );

const strictCoordinator =
  new StoredObservationStrictCoordinator(
    states,
    strictResolver,
  );

const strictService =
  new ChromeStrictExecutionService(strictCoordinator);

const authorizations =
  new InMemoryAuthorizationStore();

const autoActOrigins =
  new MutableExactOriginAllowlist();

const authorizationIssuance =
  new StrictClickAuthorizationIssuanceService(
    states,
    authorizations,
    autoActOrigins,
  );

const operatorApprovals =
  new OperatorApprovalStore(
    states,
    autoActOrigins,
    authorizationIssuance,
  );

const enterprisePolicies =
  new ChromeManagedEnterpriseAuthorizationPolicyProvider(
    chrome.storage.managed,
  );

const enterpriseReplay =
  new ChromeStorageEnterpriseAssertionReplayStore(
    chrome.storage.local,
  );

const enterprisePolicyAuthorization =
  new EnterprisePolicyAuthorizationService(
    states,
    enterprisePolicies,
    enterpriseReplay,
    authorizationIssuance,
  );

const clickDispatcher =
  new ChromeStrictClickDispatcher(
    debuggerTransport,
  );

// 写入只在本扩展的 isolated world 中进行：按 origin 精确定位，不尝试其它上下文。
const strictValueWriter =
  new IsolatedWorldStrictActionRunner(
    debuggerTransport,
    "chrome-extension://" + chrome.runtime.id,
  );

const policyGatedClick =
  new PolicyGatedStrictClickExecutor(
    strictCoordinator,
    clickDispatcher,
    authorizations,
    autoActOrigins,
    createRootPresentationFence(
      debuggerTransport,
    ),
    strictValueWriter,
  );

const trustedHostService =
  new TrustedHostExecutionService(
    states,
    autoActOrigins,
    authorizationIssuance,
    policyGatedClick,
    perceptionService,
    {
      operatorApprovals,
      enterprisePolicyAuthorization,
    },
  );

const browserApiService =
  new HighLevelBrowserApiService(
    states,
    perceptionService,
    trustedHostService,
    tabOwnership,
    chrome.tabs,
    {
      changeSignals: browserChangeSignals,
    },
  );

bindChromeDomLifecycle(chrome, lifecycle);
registerBrowserChangeSignals(
  chrome.runtime,
  chrome,
  browserChangeSignals,
);
chrome.tabs.onRemoved.addListener((tabId) => {
  browserChangeSignals.clearTab(tabId);
  tabOwnership.tabRemoved(tabId);
});
bindAuthorizationLifecycle(
  chrome,
  authorizations,
  operatorApprovals,
);

registerObserveTabBackgroundListener(
  chrome.runtime,
  perceptionService,
  tabOwnership,
);

registerOperatorApprovalUiIngress(
  chrome.runtime as unknown as
    OperatorApprovalRuntimeApi,
  operatorApprovals,
);
bindOperatorApprovalBadge(
  chrome.action,
  operatorApprovals,
);

// 普通 Extension runtime message 只暴露 prepare，不暴露真实 input dispatch。
registerStrictExecutionBackgroundListener(
  chrome.runtime,
  strictService,
);

// 真实授权 + dispatch 仅存在于指定 Native Messaging host 通道。
// Host 缺失时 connectTrustedNativeIngress 安全降级为“不存在执行入口”。
connectTrustedNativeIngress(
  chrome.runtime,
  trustedHostService,
  browserApiService,
);
