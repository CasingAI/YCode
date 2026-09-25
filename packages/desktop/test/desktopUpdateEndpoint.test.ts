import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "@zcode/shared";
import {
  buildDesktopUpdateEndpointUrl,
  DEFAULT_DESKTOP_UPDATE_ENDPOINT_ORIGIN,
  resolveDesktopUpdateEndpointOrigin,
} from "../src/main/desktopUpdateEndpoint.js";

test("Desktop 升级 endpoint 固定为 localhost", () => {
  assert.equal(DEFAULT_DESKTOP_UPDATE_ENDPOINT_ORIGIN, "http://localhost");
  assert.equal(resolveDesktopUpdateEndpointOrigin(), "http://localhost");
});

test("Desktop 升级请求路径保持在 localhost", () => {
  assert.equal(
    buildDesktopUpdateEndpointUrl("/api/v1/client/configs"),
    "http://localhost/api/v1/client/configs",
  );
  assert.equal(
    buildDesktopUpdateEndpointUrl("/api/v1/releases/electron/manifest"),
    "http://localhost/api/v1/releases/electron/manifest",
  );
});

test("Desktop 升级 endpoint 不改写产品 API endpoint", () => {
  assert.equal(DEFAULT_ZCODE_ENDPOINT_ORIGIN, "https://zcode.z.ai");
});
