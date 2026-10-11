import assert from "node:assert/strict";
import test from "node:test";
import {
  extractDeepLinkUrlFromArgs,
  extractSessionCitationOpenParams,
  isSessionCitationOpenUrl,
} from "../src/main/desktopDeepLinkUrl.js";

function parse(url: string): URL {
  return new URL(url);
}

test("会话引用深链判定：只认 ycode://session/open", () => {
  assert.equal(isSessionCitationOpenUrl(parse("ycode://session/open?sessionId=sess_a")), true);
  assert.equal(
    isSessionCitationOpenUrl(parse("ycode://session/open?sessionId=sess_a&search=%E4%B9%8B")),
    true,
  );
  // host/path 不对不认。
  assert.equal(isSessionCitationOpenUrl(parse("ycode://other/open?sessionId=sess_a")), false);
  assert.equal(isSessionCitationOpenUrl(parse("ycode://session/other?sessionId=sess_a")), false);
  // zcode 不认（现有四路路由不动）。
  assert.equal(isSessionCitationOpenUrl(parse("zcode://session/open?sessionId=sess_a")), false);
  assert.equal(isSessionCitationOpenUrl(parse("https://example.com")), false);
});

test("会话引用参数提取：双参，sessionId 严格校验", () => {
  const full = extractSessionCitationOpenParams(
    parse("ycode://session/open?sessionId=sess_a&search=%E4%B9%8B%E5%89%8D"),
  );
  assert.equal(full?.sessionId, "sess_a");
  assert.equal(full?.search, "之前");

  // search 可缺席。
  const bare = extractSessionCitationOpenParams(parse("ycode://session/open?sessionId=sess_a"));
  assert.equal(bare?.sessionId, "sess_a");
  assert.equal(bare?.search, "");

  // 伪造 sessionId 直接 null：空、空白、含分隔符。
  assert.equal(extractSessionCitationOpenParams(parse("ycode://session/open")), null);
  assert.equal(
    extractSessionCitationOpenParams(parse("ycode://session/open?sessionId=%20%20")),
    null,
  );
  assert.equal(
    extractSessionCitationOpenParams(parse("ycode://session/open?sessionId=a%20b")),
    null,
  );
  assert.equal(extractSessionCitationOpenParams(parse("ycode://session/open?sessionId=a/b")), null);
  // 非 session 路由返回 null。
  assert.equal(extractSessionCitationOpenParams(parse("zcode://share/import?code=abc")), null);
});

test("argv 提取：ycode 链接可被捡出", () => {
  const found = extractDeepLinkUrlFromArgs([
    "--something",
    "ycode://session/open?sessionId=sess_a&search=%E4%B9%8B",
  ]);
  assert.equal(found, "ycode://session/open?sessionId=sess_a&search=%E4%B9%8B");
});
