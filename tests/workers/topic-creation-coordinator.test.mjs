import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TopicCreationCoordinator } from "../../workers/topic-creation-coordinator.mjs";
import {
  parseTextbookCandidate,
  parseSharedTextbook,
} from "../../src/shared-textbook-format.ts";

class Storage {
  data = new Map();
  tail = Promise.resolve();
  fail = false;
  async get(key) {
    return structuredClone(this.data.get(key));
  }
  transaction(update) {
    const operation = this.tail.then(async () => {
      const data = structuredClone(this.data);
      const result = await update({
        get: async (key) => structuredClone(data.get(key)),
        put: async (key, value) => {
          if (this.fail === true || this.fail === key)
            throw Error("保存に失敗");
          assert.ok(
            new TextEncoder().encode(JSON.stringify(value)).length < 128 * 1024,
          );
          data.set(key, structuredClone(value));
        },
        delete: async (key) => {
          if (this.fail === true || this.fail === key)
            throw Error("保存に失敗");
          return data.delete(key);
        },
        setAlarm: async (at) => data.set("alarm", at),
        deleteAlarm: async () => data.delete("alarm"),
      });
      this.data = data;
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
const owner = "a".repeat(64),
  other = "b".repeat(64);
const envelope = JSON.parse(
  await readFile(
    new URL("../fixtures/shared-textbook-v2.json", import.meta.url),
    "utf8",
  ),
);
const decode = (s) => Buffer.from(s, "base64").toString("utf8");
const record = JSON.parse(decode(envelope.record));
const raw = decode(record.request),
  draftRaw = decode(record.draft),
  reviewRaw = decode(record.review);
const candidate = await parseTextbookCandidate(raw, draftRaw);
const id = candidate.request.id.toLowerCase();
const quote = (purpose) => ({
  modelId: "fixture",
  provider: "openai",
  model: "fixture",
  purpose,
  maxMilliYen: 1000,
  quoteDigest: (purpose === "book-addition" ? "c" : "d").repeat(64),
  inputTokens: 8000,
  outputTokens: 2000,
  dataConditions: "合成検証のみ",
  priceCheckedAt: "2026-11-18T00:00:00Z",
  costCheckedAt: "2026-11-18T00:00:00Z",
});
const generation = quote("book-addition"),
  review = quote("evidence-check"),
  quotes = [generation, review];
const approval = {
  confirm: true,
  approvedPublicText: true,
  generation,
  review,
};
const result = (input) => ({
  status: "complete",
  account: owner,
  draft: {
    kind:
      input.purpose === "book-addition"
        ? "topic-textbook-draft"
        : "topic-textbook-review",
    requestDigest: candidate.requestDigest,
    draftDigest: candidate.draftDigest,
    json: input.purpose === "book-addition" ? draftRaw : reviewRaw,
    invocation: {
      id:
        input.purpose === "book-addition"
          ? record.generator.id
          : record.reviewer.id,
      provider: "openai",
      model: "fixture",
    },
    ...(input.purpose === "evidence-check" ? { allChecksPassed: true } : {}),
  },
});
function fixture(options = {}) {
  const storage = new Storage(),
    calls = [],
    lookups = [];
  const ledger = new Map();
  let at = 1800000000000;
  const settings = {
    enabled: true,
    now: () => at,
    run: async (_owner, input) => {
      calls.push(input);
      const reply = result(input);
      ledger.set(input.requestId, reply);
      return reply;
    },
    lookup: async (_owner, input) => {
      lookups.push(input);
      return (
        ledger.get(input.requestId) ?? { status: "not-found", account: owner }
      );
    },
    ...options,
  };
  return {
    storage,
    calls,
    lookups,
    ledger,
    settings,
    coordinator: new TopicCreationCoordinator(storage, settings),
    restart: (extra = {}) =>
      new TopicCreationCoordinator(storage, { ...settings, ...extra }),
    tick: () => {
      at += 60000;
    },
  };
}
async function approved(f) {
  await f.coordinator.save(owner, raw);
  return f.coordinator.approve(owner, id, approval, quotes);
}

test("資料と学習目的を先に保存し、費用承認前は生成せず、再起動して同じ依頼を復元する", async () => {
  const f = fixture();
  const first = await f.coordinator.save(owner, raw);
  assert.equal(first.state, "draft");
  assert.equal(first.learningGoal, candidate.request.learningGoal);
  assert.equal(first.requestRaw, raw);
  await f.restart().alarm();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.restart().save(owner, raw), first);
  assert.equal(f.storage.data.has("alarm"), false);
  await assert.rejects(
    f.coordinator.save(
      owner,
      raw.replace(candidate.request.learningGoal, "別の目的"),
    ),
    /conflict/,
  );
  assert.deepEqual(await f.coordinator.read(owner, id), first);
});

test("二段階の承認とalarmを同時確定し、生成・独立検証・不変版保存を再起動をまたいで完了する", async () => {
  const f = fixture();
  const start = await approved(f);
  assert.equal(start.state, "generation");
  assert.equal(f.calls.length, 0);
  assert.equal(f.storage.data.get("alarm"), 1800000001000);
  await f.restart().alarm();
  const middle = await f.coordinator.read(owner, id);
  assert.equal(middle.state, "review");
  assert.equal(middle.book, null);
  assert.equal(f.calls.length, 1);
  assert.ok(f.storage.data.has("alarm"));
  await f.restart().alarm();
  const ready = await f.coordinator.read(owner, id);
  const book = await parseSharedTextbook(ready.book);
  assert.equal(ready.state, "ready");
  assert.equal(book.id, `${start.bookID}:1`);
  assert.equal(book.request.topic.name, candidate.request.topic.name);
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].requestId, f.calls[1].requestId);
  assert.equal(f.calls[1].generationRequestId, f.calls[0].requestId);
  assert.equal(
    f.calls[1].generatorInvocation,
    record.generator.id.toLowerCase(),
  );
  assert.equal(f.calls[1].draftRaw, draftRaw);
  assert.equal(f.storage.data.has("alarm"), false);
  assert.deepEqual(await f.restart().approve(owner, id, approval, []), ready);
  await f.restart().alarm();
  assert.deepEqual(await f.restart().read(owner, id), ready);
  assert.equal(f.calls.length, 2);
  assert.equal(f.lookups.length, 0);
  assert.equal(ready.book.includes("approvedMaxMilliYen"), false);
});

test("承認の保存失敗ではalarmも予約も送信も残さず、再確認してから開始する", async () => {
  const f = fixture();
  await f.coordinator.save(owner, raw);
  f.storage.fail = true;
  await assert.rejects(
    f.coordinator.approve(owner, id, approval, quotes),
    /保存/,
  );
  assert.equal(f.storage.data.has("alarm"), false);
  assert.equal((await f.coordinator.read(owner, id)).state, "draft");
  f.storage.fail = false;
  await f.restart().alarm();
  assert.equal(f.calls.length, 0);
});

for (const variant of ["missing", "purpose", "total", "changed", "unconfirmed"])
  test(`費用承認の${variant}を拒否し依頼を保持する`, async () => {
    const f = fixture();
    await f.coordinator.save(owner, raw);
    const value = structuredClone(approval);
    let current = quotes;
    if (variant === "missing") current = [generation];
    if (variant === "purpose") value.review.purpose = "book-addition";
    if (variant === "total") {
      value.generation.maxMilliYen = 300000;
      value.review.maxMilliYen = 300000;
    }
    if (variant === "changed") value.review.quoteDigest = "e".repeat(64);
    if (variant === "unconfirmed") value.confirm = false;
    await assert.rejects(f.coordinator.approve(owner, id, value, current));
    assert.equal((await f.coordinator.read(owner, id)).state, "draft");
    assert.equal(f.storage.data.has("alarm"), false);
  });

test("並行した承認とalarm再配送でも各段階の有料送信は一回に限定する", async () => {
  const f = fixture();
  await f.coordinator.save(owner, raw);
  await Promise.all([
    f.coordinator.approve(owner, id, approval, quotes),
    f.restart().approve(owner, id, approval, quotes),
  ]);
  for (let n = 0; n < 3; n++)
    await Promise.all([f.coordinator.alarm(), f.restart().alarm()]);
  assert.equal((await f.coordinator.read(owner, id)).state, "ready");
  assert.equal(f.calls.length, 2);
});

test("送信後に結果保存が失敗しても台帳の照会から回復し、生成を再送しない", async () => {
  const f = fixture();
  f.settings.run = async (_owner, input) => {
    f.calls.push(input);
    const reply = result(input);
    f.ledger.set(input.requestId, reply);
    f.storage.fail = `topic-jobs:record:${input.requestId}`;
    return reply;
  };
  const coordinator = f.restart();
  await coordinator.save(owner, raw);
  await coordinator.approve(owner, id, approval, quotes);
  await assert.rejects(coordinator.alarm(), /保存/);
  assert.equal(f.calls.length, 1);
  f.storage.fail = false;
  f.tick();
  await f
    .restart({
      run: async () => {
        throw Error("再送禁止");
      },
    })
    .alarm();
  assert.equal(f.calls.length, 1);
  assert.equal(f.lookups.length, 1);
  assert.equal((await coordinator.read(owner, id)).state, "review");
});

for (const variant of [
  "failed-check",
  "lying-check",
  "digest",
  "invocation",
  "model",
  "wrong-owner",
])
  test(`不正な検証結果 ${variant} を完成版にしない`, async () => {
    const f = fixture({
      run: async (_owner, input) => {
        const reply = result(input);
        if (input.purpose === "evidence-check") {
          if (variant === "failed-check") reply.draft.allChecksPassed = false;
          if (variant === "lying-check") {
            const value = JSON.parse(reviewRaw);
            value.sections[0].checks[0].passed = false;
            reply.draft.json = JSON.stringify(value);
          }
          if (variant === "digest") reply.draft.draftDigest = "0".repeat(64);
          if (variant === "invocation")
            reply.draft.invocation.id = record.generator.id.toUpperCase();
          if (variant === "model") reply.draft.invocation.model = "別のモデル";
          if (variant === "wrong-owner") reply.account = other;
        }
        return reply;
      },
    });
    await approved(f);
    await f.coordinator.alarm();
    await f.coordinator.alarm();
    const current = await f.coordinator.read(owner, id);
    assert.equal(
      current.state,
      variant === "wrong-owner" ? "held" : "rejected",
    );
    assert.equal(current.book, null);
    assert.equal(f.storage.data.has("alarm"), false);
  });

test("停止設定では資料と結果を保持し、alarmを消し、新しい送信をしない", async () => {
  const f = fixture();
  await approved(f);
  const stopped = f.restart({ enabled: false });
  await stopped.alarm();
  assert.equal(f.calls.length, 0);
  assert.equal(f.storage.data.has("alarm"), false);
  assert.equal((await stopped.read(owner, id)).state, "generation");
  await assert.rejects(
    stopped.approve(owner, id, approval, quotes),
    /unconfigured/,
  );
  await f.restart().approve(owner, id, approval, []);
  assert.ok(f.storage.data.has("alarm"));
});

test("別利用者の読取・同意・上書きを拒否し、壊れた目録を初期化しない", async () => {
  const f = fixture();
  await approved(f);
  await assert.rejects(f.coordinator.read(other, id), /owner/);
  await assert.rejects(
    f.coordinator.approve(other, id, approval, quotes),
    /owner/,
  );
  await assert.rejects(f.coordinator.save(other, raw), /owner/);
  f.storage.data.set("topic-creations:index", { version: 2 });
  await assert.rejects(f.restart().save(owner, raw), /invalid/);
  assert.deepEqual(f.storage.data.get("topic-creations:index"), { version: 2 });
});

test("完成ファイルの破損を返さず、保存した記録を保持する", async () => {
  const f = fixture();
  await approved(f);
  await f.coordinator.alarm();
  await f.coordinator.alarm();
  f.storage.data.set(`topic-jobs:creation-book:${id}:0`, '"壊れたファイル"');
  await assert.rejects(f.restart().read(owner, id), /invalid/);
  assert.equal(
    f.storage.data.get(`topic-creations:record:${id}`).state,
    "ready",
  );
});

test("結果不明の生成を明示照会で回収し、生成を再送せず検証から再開する", async () => {
  const f = fixture();
  const run = f.settings.run;
  f.settings.run = async (account, input) =>
    input.purpose === "book-addition"
      ? { status: "unknown", account }
      : run(account, input);
  const c = f.restart();
  await c.save(owner, raw);
  await c.approve(owner, id, approval, quotes);
  await c.alarm();
  assert.equal((await c.read(owner, id)).state, "held");
  assert.equal(f.storage.data.has("alarm"), false);
  assert.equal((await c.refresh(owner, id)).state, "held");
  const input = f.lookups[0];
  f.ledger.set(id, result(input));
  assert.equal((await c.refresh(owner, id)).state, "review");
  await c.alarm();
  assert.equal((await c.read(owner, id)).state, "ready");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].purpose, "evidence-check");
});

test("停止中にも遅れて届いた検証結果を照会・保存でき、新たな送信はしない", async () => {
  const f = fixture();
  const run = f.settings.run;
  f.settings.run = async (account, input) =>
    input.purpose === "evidence-check"
      ? { status: "unknown", account }
      : run(account, input);
  const c = f.restart();
  await c.save(owner, raw);
  await c.approve(owner, id, approval, quotes);
  await c.alarm();
  await c.alarm();
  const metadata = f.storage.data.get(`topic-creations:record:${id}`);
  const input = JSON.parse(
    f.storage.data.get(`topic-jobs:input:${metadata.reviewId}:0`),
  );
  f.ledger.set(metadata.reviewId, result(input));
  const stopped = f.restart({ enabled: false });
  assert.equal((await stopped.refresh(owner, id)).state, "ready");
  assert.equal(f.calls.length, 1);
  assert.equal(f.storage.data.has("alarm"), false);
});

test("未承認と終了済みの控えを明示整理し、教材・段階の断片を同時に除去する", async () => {
  const f = fixture();
  await approved(f);
  await f.coordinator.alarm();
  await f.coordinator.alarm();
  const ready = await f.coordinator.read(owner, id);
  const ledger = structuredClone(f.ledger);
  await assert.rejects(f.coordinator.remove(owner, id, false));
  await f.coordinator.remove(owner, id, true);
  assert.equal(await f.coordinator.read(owner, id), null);
  assert.deepEqual(f.ledger, ledger);
  assert.deepEqual(f.storage.data.get("topic-jobs:index").ids, []);
  assert.deepEqual(f.storage.data.get("topic-creations:index").ids, []);
  assert.ok([...f.storage.data.keys()].every((key) => key.endsWith(":index")));
  assert.equal((await parseSharedTextbook(ready.book)).id, `${ready.bookID}:1`);
  await f.coordinator.save(owner, raw);
  await f.coordinator.remove(owner, id, true);
  assert.equal(await f.coordinator.read(owner, id), null);
});

test("進行中・結果不明の作成控えは削除せず、停止後の予定は確認付きで再開する", async () => {
  const f = fixture();
  await approved(f);
  await assert.rejects(f.coordinator.remove(owner, id, true), /active/);
  await f.restart({ enabled: false }).alarm();
  await assert.rejects(f.coordinator.resume(owner, id, false));
  await f.coordinator.resume(owner, id, true);
  assert.ok(f.storage.data.has("alarm"));
  await f.coordinator.alarm();
  await f.coordinator.alarm();
  assert.equal((await f.coordinator.read(owner, id)).state, "ready");
  await assert.rejects(f.coordinator.resume(owner, id, true), /active/);
});

for (const variant of ["draft-parts", "result-parts", "stage-record"])
  test(`壊れた ${variant} を毎秒起動・上書きせず保持する`, async () => {
    const f = fixture();
    await approved(f);
    await f.coordinator.advance();
    if (variant === "result-parts") await f.coordinator.queue.alarm();
    const key =
      variant === "draft-parts"
        ? `topic-jobs:creation-request:${id}:0`
        : variant === "result-parts"
          ? `topic-jobs:result:${id}:0`
          : `topic-jobs:record:${id}`;
    f.storage.data.set(key, { future: true });
    await f.coordinator.alarm();
    assert.deepEqual(f.storage.data.get(key), { future: true });
    assert.equal(f.storage.data.has("alarm"), false);
    assert.equal(
      f.storage.data.get(`topic-creations:record:${id}`).state,
      "held",
    );
  });

test("作成目録が送信中に破損しても有料段階の結果保存を巻き戻さない", async () => {
  const f = fixture();
  f.settings.run = async (_owner, input) => {
    f.storage.data.set("topic-creations:index", { version: 99 });
    return result(input);
  };
  const c = f.restart();
  await c.save(owner, raw);
  await c.approve(owner, id, approval, quotes);
  await assert.rejects(c.alarm(), /invalid/);
  assert.equal((await c.queue.read(owner, id)).state, "complete");
  assert.deepEqual(f.storage.data.get("topic-creations:index"), {
    version: 99,
  });
});

test("一件の作成記録の破損が他の正常な承認と一覧を妨げない", async () => {
  const f = fixture();
  await f.coordinator.save(owner, raw);
  f.storage.data.set(`topic-creations:record:${id}`, { version: 99 });
  const request = JSON.parse(raw);
  request.id = crypto.randomUUID();
  await f.coordinator.save(owner, JSON.stringify(request));
  await f.coordinator.approve(owner, request.id, approval, quotes);
  const listed = await f.coordinator.list(owner);
  assert.equal(listed.creations.length, 2);
  assert.equal(listed.creations[0].title, request.topic.name);
  assert.deepEqual(listed.creations[1], { id, state: "unavailable" });
  assert.equal(listed.creations[0].book, undefined);
  assert.deepEqual(f.storage.data.get(`topic-creations:record:${id}`), {
    version: 99,
  });
});

test("控えの上限とページ分割を守り、明示整理後に新しい依頼を保存できる", async () => {
  const f = fixture();
  const request = JSON.parse(raw),
    ids = [];
  for (let n = 0; n < 100; n++) {
    request.id = crypto.randomUUID();
    ids.push(request.id);
    await f.coordinator.save(owner, JSON.stringify(request));
  }
  request.id = crypto.randomUUID();
  await assert.rejects(
    f.coordinator.save(owner, JSON.stringify(request)),
    /capacity/,
  );
  const seen = [];
  let after;
  do {
    const page = await f.coordinator.list(owner, after);
    assert.equal(page.creations.length, 20);
    seen.push(...page.creations.map((r) => r.id));
    after = page.next;
  } while (after);
  assert.deepEqual(seen, ids.toReversed());
  await assert.rejects(f.coordinator.list(owner, request.id), /cursor/);
  await f.coordinator.remove(owner, ids[0], true);
  await f.coordinator.save(owner, JSON.stringify(request));
  assert.equal((await f.coordinator.read(owner, request.id)).state, "draft");
});

for (const variant of ["digest", "model", "kind", "rejected"])
  test(`生成段階の ${variant} を検証へ送らない`, async () => {
    let calls = 0;
    const f = fixture({
      run: async (_owner, input) => {
        calls++;
        const value = result(input);
        if (variant === "digest") value.draft.requestDigest = "0".repeat(64);
        if (variant === "model") value.draft.invocation.model = "別モデル";
        if (variant === "kind") {
          value.draft.kind = "topic-textbook-review";
          value.draft.allChecksPassed = true;
        }
        if (variant === "rejected")
          return { status: "rejected", draft: null, account: owner };
        return value;
      },
    });
    await approved(f);
    await f.coordinator.alarm();
    await f.coordinator.alarm();
    assert.equal((await f.coordinator.read(owner, id)).state, "rejected");
    assert.equal(calls, 1);
    assert.equal(f.storage.data.has("alarm"), false);
  });

test("控え整理の途中で保存が失敗しても教材と二段階の結果をすべて保持する", async () => {
  const f = fixture();
  await approved(f);
  await f.coordinator.alarm();
  await f.coordinator.alarm();
  const before = await f.coordinator.read(owner, id),
    data = structuredClone(f.storage.data);
  f.storage.fail = `topic-jobs:creation-book:${id}:0`;
  await assert.rejects(f.coordinator.remove(owner, id, true), /保存/);
  assert.deepEqual(f.storage.data, data);
  assert.deepEqual(await f.coordinator.read(owner, id), before);
});

test("取消済みの段階から次の生成を始めず、拒否した作成控えを明示整理できる", async () => {
  const f = fixture();
  await approved(f);
  await f.coordinator.advance();
  await f.coordinator.queue.cancel(owner, id);
  await f.coordinator.alarm();
  assert.equal((await f.coordinator.read(owner, id)).state, "rejected");
  assert.equal(f.calls.length, 0);
  await f.coordinator.remove(owner, id, true);
  assert.equal(await f.coordinator.read(owner, id), null);
});

test("背景で進める作成は20件までに制限し、21件目の草案は保持する", async () => {
  const f = fixture(),
    request = JSON.parse(raw);
  for (let n = 0; n < 21; n++) {
    request.id = crypto.randomUUID();
    await f.coordinator.save(owner, JSON.stringify(request));
    if (n < 20)
      await f.coordinator.approve(owner, request.id, approval, quotes);
    else
      await assert.rejects(
        f.coordinator.approve(owner, request.id, approval, quotes),
        /capacity/,
      );
  }
  assert.equal((await f.coordinator.read(owner, request.id)).state, "draft");
  assert.equal(f.calls.length, 0);
});

test("他の作成の検証操作IDを新しい生成のIDとして予約しない", async () => {
  const f = fixture();
  await f.coordinator.save(owner, raw);
  const request = JSON.parse(raw);
  request.id = f.storage.data.get(`topic-creations:record:${id}`).reviewId;
  await assert.rejects(
    f.coordinator.save(owner, JSON.stringify(request)),
    /conflict/,
  );
  assert.equal((await f.coordinator.list(owner)).creations.length, 1);
  assert.equal(f.calls.length, 0);
});

for (const value of [undefined, false])
  test(`資料送信の同意 ${String(value)} を費用確認で代用しない`, async () => {
    const f = fixture();
    await f.coordinator.save(owner, raw);
    await assert.rejects(
      f.coordinator.approve(
        owner,
        id,
        { ...approval, approvedPublicText: value },
        quotes,
      ),
    );
    assert.equal((await f.coordinator.read(owner, id)).state, "draft");
    assert.equal(
      f.storage.data.get(`topic-creations:record:${id}`).approvedPublicText,
      null,
    );
    assert.equal(f.storage.data.has("alarm"), false);
  });

test("結果不明の作成も20件の枠に含め、回収時に21件の進行へ増やさない", async () => {
  const f = fixture({
    run: async (account) => ({ status: "unknown", account }),
  });
  await approved(f);
  await f.coordinator.alarm();
  assert.equal((await f.coordinator.read(owner, id)).state, "held");
  const request = JSON.parse(raw);
  for (let n = 0; n < 20; n++) {
    request.id = crypto.randomUUID();
    await f.coordinator.save(owner, JSON.stringify(request));
    if (n < 19)
      await f.coordinator.approve(owner, request.id, approval, quotes);
    else
      await assert.rejects(
        f.coordinator.approve(owner, request.id, approval, quotes),
        /capacity/,
      );
  }
  f.ledger.set(id, result({ purpose: "book-addition" }));
  assert.equal((await f.coordinator.refresh(owner, id)).state, "review");
  assert.equal((await f.coordinator.read(owner, request.id)).state, "draft");
  assert.equal(
    f.storage.data.get(`topic-creations:record:${id}`).approvedPublicText,
    true,
  );
});

for (const status of [
  "id-conflict",
  "budget-exhausted",
  "provider-budget-exhausted",
  "account-forbidden",
  "busy",
  "quote-changed",
  "cost-policy-changed",
  "unconnected",
  "cost-limit",
  "cost-unapproved",
  "model-unapproved",
  "cost-unconfigured",
  "count-unconfigured",
  "input-limit",
])
  for (const purpose of ["book-addition", "evidence-check"])
    test(`段階の確定拒否 ${purpose}/${status} を結果不明と区別し、台帳を消さず控えを整理する`, async () => {
      const f = fixture({
        run: async (_owner, input) =>
          input.purpose === purpose
            ? { status, account: owner }
            : result(input),
      });
      f.ledger.set(id, { unrelatedRetainedOperation: true });
      const ledger = structuredClone(f.ledger);
      await approved(f);
      await f.coordinator.alarm();
      await f.coordinator.alarm();
      assert.equal((await f.coordinator.read(owner, id)).state, "rejected");
      await f.coordinator.remove(owner, id, true);
      assert.equal(await f.coordinator.read(owner, id), null);
      assert.deepEqual(f.ledger, ledger);
    });

test("有料処理後のキー変更を未送信の拒否と断定せず、同じ台帳結果を回収する", async () => {
  const f = fixture();
  const run = f.settings.run;
  f.settings.run = async (account, input) => {
    const completed = await run(account, input);
    return input.purpose === "book-addition"
      ? { status: "credential-changed", account }
      : completed;
  };
  const c = f.restart();
  await c.save(owner, raw);
  await c.approve(owner, id, approval, quotes);
  await c.alarm();
  assert.equal((await c.read(owner, id)).state, "held");
  await assert.rejects(c.remove(owner, id, true), /active/);
  assert.equal((await c.refresh(owner, id)).state, "review");
  await c.alarm();
  assert.equal((await c.read(owner, id)).state, "ready");
  assert.equal(
    f.calls.filter((input) => input.purpose === "book-addition").length,
    1,
  );
});

test("破損した生成結果がある保留の再照会は、進行中と表示せず同じ保留理由を保持する", async () => {
  const f = fixture();
  const run = f.settings.run;
  f.settings.run = async (account, input) => {
    const completed = await run(account, input);
    return input.purpose === "evidence-check"
      ? { status: "unknown", account }
      : completed;
  };
  const c = f.restart();
  await c.save(owner, raw);
  await c.approve(owner, id, approval, quotes);
  await c.alarm();
  await c.alarm();
  const fragment = `topic-jobs:result:${id}:0`;
  f.storage.data.set(fragment, "{}");
  await c.refresh(owner, id);
  const current = await c.read(owner, id);
  assert.equal(current.state, "held");
  assert.equal(current.reason, "invalid-result");
  assert.equal(f.storage.data.get(fragment), "{}");
  assert.equal(f.storage.data.has("alarm"), false);
});
