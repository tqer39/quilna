import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ledgerSchema } from "./ledger-schema.mjs";

export class FileLedger {
  constructor(directory) {
    this.directory = directory;
  }
  async read() {
    try {
      // transactionが原子的に置換する確定済みのsnapshotだけを読む。
      return ledgerSchema.parse(
        JSON.parse(await readFile(join(this.directory, "budget.json"), "utf8")),
      );
    } catch (error) {
      if (error.code === "ENOENT") return { schema: 1, records: [] };
      throw Error("ledger-invalid");
    }
  }
  async transaction(update) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, "transaction.lock");
    // No stale-lock guessing or automatic replay: crash recovery is a manual task.
    await mkdir(lock, { mode: 0o700 });
    const file = join(this.directory, "budget.json");
    const temporary = join(this.directory, `pending-${randomUUID()}.json`);
    try {
      let ledger;
      try {
        ledger = ledgerSchema.parse(JSON.parse(await readFile(file, "utf8")));
      } catch (error) {
        if (error.code !== "ENOENT") throw Error("ledger-invalid");
        ledger = { schema: 1, records: [] };
      }
      const result = update(ledger);
      const serialized = JSON.stringify(ledgerSchema.parse(ledger));
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(serialized);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
      // macOS/Linux: make the renamed directory entry durable before dispatch.
      const dir = await open(this.directory, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      return result;
    } finally {
      await rm(temporary, { force: true });
      await rm(lock, { recursive: true });
    }
  }
}
