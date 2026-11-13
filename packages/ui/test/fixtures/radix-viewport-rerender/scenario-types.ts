export type Assertion = {
  name: string;
  ok: boolean;
  detail?: unknown;
};

export type Check = (name: string, ok: boolean, detail?: unknown) => boolean;

export type Metrics = Record<string, unknown>;
