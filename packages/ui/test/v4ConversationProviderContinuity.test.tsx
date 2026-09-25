import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IPlatformService } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import {
  useV4Conversation,
  V4ConversationProvider,
  V4PaneConversationProvider,
} from "../src/v4/V4ConversationContext.js";
import { TabStoreProvider } from "../src/store/TabStoreProvider.js";

function createFakeServices(): IServiceAccessor {
  const subscription = { dispose() {} };
  return {
    zcodeAgentService: {
      onDynamicConversationFrame: () => () => subscription,
      onAgentRuntimeRestarted: () => subscription,
    },
  } as unknown as IServiceAccessor;
}

function MountedConversationMarker() {
  useV4Conversation();
  return <span data-conversation-mounted="true" />;
}

test("transport 断线时本地 V4 conversation provider 仍保持挂载", () => {
  const markup = renderToStaticMarkup(
    <ServiceProvider
      services={createFakeServices()}
      connection={{ status: "reconnecting", generation: 2, rpcReady: false }}
    >
      <PlatformProvider platform={{} as IPlatformService}>
        <TabStoreProvider>
          <V4ConversationProvider workspacePath="/workspace/local">
            <MountedConversationMarker />
          </V4ConversationProvider>
        </TabStoreProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );

  assert.match(markup, /data-conversation-mounted="true"/);
});

test("transport 断线时本地 pane provider 仍保持挂载", () => {
  const markup = renderToStaticMarkup(
    <ServiceProvider
      services={createFakeServices()}
      connection={{ status: "reconnecting", generation: 2, rpcReady: false }}
    >
      <PlatformProvider platform={{} as IPlatformService}>
        <TabStoreProvider>
          <V4PaneConversationProvider scope={{ workspacePath: "/workspace/local-pane" }}>
            <MountedConversationMarker />
          </V4PaneConversationProvider>
        </TabStoreProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );

  assert.match(markup, /data-conversation-mounted="true"/);
});
