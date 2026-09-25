import assert from "node:assert/strict";
import test from "node:test";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";

test("/init model prompt uses Y Code for its built-in identity", () => {
  const prompt = resolveZCodeBuiltinPromptCommand("/init", { workingDirectory: "/workspace" });

  assert.ok(prompt);
  assert.match(prompt, /You are running Y Code's built-in \/init command\./);
  assert.match(prompt, /future Y Code agents/);
  assert.doesNotMatch(prompt, /\bZCode\b/);
});
