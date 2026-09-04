import type { ApplicationOperationPort } from "./application-operation-port.js";

type ApplicationOperationMethodName = {
  [Key in keyof ApplicationOperationPort]-?: ApplicationOperationPort[Key] extends (...args: any[]) => any ? Key : never;
}[keyof ApplicationOperationPort];

export type AsyncApplicationOperationPort = {
  [Key in ApplicationOperationMethodName]: ApplicationOperationPort[Key] extends (...args: infer Arguments) => infer Result
    ? (...args: Arguments) => Promise<Awaited<Result>>
    : never;
} & {
  readonly backend: "postgres";
};
