import { memo, useEffect } from "react";
import { App } from "@/App.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import type { AppProps } from "@/app-shell/types.js";
import type { RootProps } from "@/root/types.js";
import type { IFeedbackService, IServiceAccessor } from "@zcode/services";
import { ConversationTelemetryWorkspaceAttachment } from "@/v4/telemetry/ConversationTelemetryAttachment.js";

const StableWorkspaceApp = memo(App);

interface RootWorkspaceContentProps {
  workspaceScopedServices: IServiceAccessor;
  baseFeedbackService: IFeedbackService;
  workspaceShellPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  isSettingsTabActive: boolean;
  isFilesTabActive?: boolean;
  handleConnectRemote: AppProps["onConnectRemote"];
  handleSelectRemoteProject: AppProps["onSelectRemoteProject"];
  handleCancelRemoteProject: AppProps["onCancelRemoteProject"];
  handleReconnectRemoteWorkspace: AppProps["onReconnectRemoteWorkspace"];
  handleCreateTask: AppProps["onCreateTask"];
  handleCreateConversationTask: NonNullable<AppProps["onCreateConversationTask"]>;
  handleResolveConversationWorkspace: NonNullable<AppProps["onResolveConversationWorkspace"]>;
  handleOpenWorkspace: AppProps["onOpenWorkspace"];
  handleOpenFolderFromWorkspaceMenu: AppProps["onOpenFolderFromWorkspaceMenu"];
  handleOpenRemoteWorkspace?: AppProps["onOpenRemoteWorkspace"];
  handleCreateScratchWorkspace: AppProps["onCreateScratchWorkspace"];
  remoteConnectionInProgress?: AppProps["remoteConnectionInProgress"];
  remoteWorkspaceSessions: NonNullable<AppProps["remoteWorkspaceSessions"]>;
  allowRemoteWorkspace: NonNullable<RootProps["allowRemoteWorkspace"]>;
  handleBackFromSettings: () => void;
  handleLogout?: () => void;
  onLogin?: () => void;
  user: AppProps["user"];
  reconnectingRemoteWorkspaceKeys: AppProps["reconnectingRemoteWorkspaceKeys"];
  remoteWorkspaceErrorByWorkspaceKey: AppProps["remoteWorkspaceErrorByWorkspaceKey"];
  reconnectingRemoteWorkspaceLogsByWorkspaceKey: AppProps["reconnectingRemoteWorkspaceLogsByWorkspaceKey"];
  remoteConnectionLogs?: AppProps["remoteConnectionLogs"];
  allowOpenWorkspace: NonNullable<RootProps["allowOpenWorkspace"]>;
  isDesktop?: RootProps["isDesktop"];
  isMacDesktop?: RootProps["isMacDesktop"];
  isWindowsDesktop?: RootProps["isWindowsDesktop"];
  supportsEmbeddedBrowser: NonNullable<RootProps["supportsEmbeddedBrowser"]>;
}

export function RootWorkspaceContent({
  workspaceScopedServices,
  baseFeedbackService,
  workspaceShellPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  isSettingsTabActive,
  isFilesTabActive = false,
  handleConnectRemote,
  handleSelectRemoteProject,
  handleCancelRemoteProject,
  handleReconnectRemoteWorkspace,
  handleCreateTask,
  handleCreateConversationTask,
  handleResolveConversationWorkspace,
  handleOpenWorkspace,
  handleOpenFolderFromWorkspaceMenu,
  handleOpenRemoteWorkspace,
  handleCreateScratchWorkspace,
  remoteConnectionInProgress,
  remoteWorkspaceSessions,
  allowRemoteWorkspace,
  handleBackFromSettings,
  handleLogout,
  onLogin,
  user,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey,
  remoteConnectionLogs,
  allowOpenWorkspace,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  supportsEmbeddedBrowser,
}: RootWorkspaceContentProps) {
  const workspaceKey = workspaceIdentity?.trim() || workspaceShellPath;

  useEffect(() => {
    logger.info("[RootWorkspaceContent] shell primary view changed", {
      isSettingsTabActive,
      isFilesTabActive,
      workspaceShellPath,
    });
  }, [isFilesTabActive, isSettingsTabActive, workspaceShellPath]);

  return (
    <div className="h-full" data-root-workspace-surface="interactive">
      {/* 设置是外壳主视图，不再盖一层。App 常驻，会话/终端/浏览器在设置态只藏不卸。 */}
      <ConversationTelemetryWorkspaceAttachment
        enabled={isDesktop === true}
        foregroundEnabled={!isSettingsTabActive && !isFilesTabActive}
        services={workspaceScopedServices}
        workspacePath={workspaceShellPath}
        workspaceIdentity={workspaceIdentity}
        remoteSessionId={workspaceRemoteSessionId}
      >
        <ServiceProvider services={workspaceScopedServices}>
          <ScopedErrorBoundary
            scope="workspace-app"
            resetKeys={[workspaceKey]}
            variant="panel"
            className="h-full"
          >
            <StableWorkspaceApp
              services={workspaceScopedServices}
              baseFeedbackService={baseFeedbackService}
              onConnectRemote={handleConnectRemote}
              onSelectRemoteProject={handleSelectRemoteProject}
              onCancelRemoteProject={handleCancelRemoteProject}
              onReconnectRemoteWorkspace={handleReconnectRemoteWorkspace}
              onLogout={handleLogout}
              onLogin={onLogin}
              user={user}
              reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
              remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
              reconnectingRemoteWorkspaceLogsByWorkspaceKey={
                reconnectingRemoteWorkspaceLogsByWorkspaceKey
              }
              remoteConnectionLogs={remoteConnectionLogs}
              workspaceAbsPath={workspaceShellPath}
              workspaceRemoteSessionId={workspaceRemoteSessionId}
              workspaceIdentity={workspaceIdentity}
              onCreateTask={handleCreateTask}
              onCreateConversationTask={handleCreateConversationTask}
              onResolveConversationWorkspace={handleResolveConversationWorkspace}
              onOpenWorkspace={handleOpenWorkspace}
              onOpenFolderFromWorkspaceMenu={handleOpenFolderFromWorkspaceMenu}
              onOpenRemoteWorkspace={handleOpenRemoteWorkspace}
              onCreateScratchWorkspace={handleCreateScratchWorkspace}
              remoteConnectionInProgress={remoteConnectionInProgress}
              onReturnToWorkspace={handleBackFromSettings}
              allowOpenWorkspace={allowOpenWorkspace}
              allowRemoteWorkspace={allowRemoteWorkspace}
              remoteWorkspaceSessions={remoteWorkspaceSessions}
              isWorkspaceVisible={!isSettingsTabActive && !isFilesTabActive}
              isDesktop={isDesktop}
              isMacDesktop={isMacDesktop}
              isWindowsDesktop={isWindowsDesktop}
              supportsEmbeddedBrowser={supportsEmbeddedBrowser}
            />
          </ScopedErrorBoundary>
        </ServiceProvider>
      </ConversationTelemetryWorkspaceAttachment>
    </div>
  );
}
