// Narrow declaration for the Node test-artifact APIs used here.
// Application code does not depend on Node globals or filesystem APIs.
declare module "node:fs/promises" {
  export function writeFile(
    path: string,
    data: string | Uint8Array,
  ): Promise<void>;
  export function readFile(path: string): Promise<Uint8Array>;
}
