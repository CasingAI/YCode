import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { chatGPTPlanModelSchema } from "@zcode/shared";
import {
  createCredentialCipherProvider,
  type CredentialCipherProvider,
} from "../credential/providers/credentialCipherProvider.js";

export const chatGPTRegistrationSchema = z
  .object({
    id: z.string(),
    clientId: z.string(),
    subject: z.string().nullable(),
    label: z.string(),
    generation: z.number().int().nonnegative(),
    authError: z.string().optional(),
    tokens: z
      .object({
        accessToken: z.string(),
        refreshToken: z.string().optional(),
        idToken: z.string(),
        scopes: z.array(z.string()),
        expiresAt: z.number(),
      })
      .strict()
      .optional(),
    models: z.array(chatGPTPlanModelSchema),
  })
  .strict();
const stateSchema = z
  .object({
    hostId: z.string().startsWith("urn:uuid:"),
    activeAccountId: z.string().nullable(),
    accounts: z.array(chatGPTRegistrationSchema),
  })
  .strict();
export type ChatGPTRegistration = z.infer<typeof chatGPTRegistrationSchema>;
export type ChatGPTPrivateState = z.infer<typeof stateSchema>;

/** 整份 registration 原子持久化；该仓储不实现、不注册通用 Credential RPC。 */
export class ChatGPTPlanStore {
  constructor(
    readonly path: string,
    private readonly cipher: CredentialCipherProvider = createCredentialCipherProvider(),
    private readonly onDidMutate?: () => void,
  ) {}
  private async load(): Promise<{ state: ChatGPTPrivateState; existed: boolean }> {
    try {
      return {
        state: stateSchema.parse(
          JSON.parse(this.cipher.decrypt(await readFile(this.path, "utf8"))),
        ),
        existed: true,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          state: { hostId: `urn:uuid:${randomUUID()}`, activeAccountId: null, accounts: [] },
          existed: false,
        };
      // 损坏或无法解密必须阻止写入，不能以空状态覆盖已有账户。
      throw new Error("chatgpt_credential_store_unavailable");
    }
  }
  async update<T>(change: (state: ChatGPTPrivateState) => T | Promise<T>): Promise<T> {
    let mutated = false;
    const result = await withFileLock(this.path, async () => {
      const { state, existed } = await this.load();
      const previous = JSON.stringify(state);
      const result = await change(state);
      const serialized = JSON.stringify(stateSchema.parse(state));
      if (!existed || serialized !== previous) {
        await atomicWritePrivateTextFile(this.path, this.cipher.encrypt(serialized));
        mutated = true;
      }
      return result;
    });
    if (mutated) this.onDidMutate?.();
    return result;
  }
  read(): Promise<ChatGPTPrivateState> {
    return this.update((state) => structuredClone(state));
  }
}
