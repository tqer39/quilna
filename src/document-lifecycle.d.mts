export type LifecycleAction = "withdraw" | "restore" | "retention" | "purge";
export type LifecycleCommand = {
  operationId: string;
  action: LifecycleAction;
  expectedRevision: number;
  expectedCatalogRevision?: number;
  expiresAt?: string | null;
  reason: string;
};
export type LifecycleOperation = { command: LifecycleCommand; at: string };
export type LifecycleState = {
  schema: 1;
  id: string;
  revision: number;
  status: "active" | "withdrawn" | "deleted";
  expiresAt: string | null;
  operations: LifecycleOperation[];
};
export const lifecycleKey: string;
export const lifecycleCommand: { parse(value: unknown): LifecycleCommand };
export function lifecycleState(value: unknown, id: string): LifecycleState;
export function lifecycleExpired(value: LifecycleState, now: number): boolean;
export function changeLifecycle(
  state: LifecycleState,
  command: LifecycleCommand,
  catalogRevision: number,
  now: number,
): { replayed: boolean; operation: LifecycleOperation };
