export const DEFAULT_DESKTOP_UPDATE_ENDPOINT_ORIGIN = "http://localhost";

export function resolveDesktopUpdateEndpointOrigin(): string {
  return new URL(DEFAULT_DESKTOP_UPDATE_ENDPOINT_ORIGIN).origin;
}

export function buildDesktopUpdateEndpointUrl(pathname: string): string {
  return new URL(pathname, `${resolveDesktopUpdateEndpointOrigin()}/`).toString();
}
