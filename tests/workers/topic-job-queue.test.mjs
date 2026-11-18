import test from "node:test";
import assert from "node:assert/strict";
import { TopicJobQueue } from "../../workers/topic-job-queue.mjs";

class Storage {
  data = new Map();
  tail = Promise.resolve();
  fail = false;
  async get(key) {
    return structuredClone(this.data.get(key));
  }
  transaction(update) {
    const operation = this.tail.then(async () => {
      const next = structuredClone(this.data);
      const result = await update({
        get: async (key) => structuredClone(next.get(key)),
        put: async (key, value) => {
          if (this.fail) throw Error("保存に失敗");
          assert.ok(
            new TextEncoder().encode(JSON.stringify(value)).length < 128 * 1024,
          );
          next.set(key, structuredClone(value));
        },
        delete: async (key) => {
          if (this.fail) throw Error("保存に失敗");
          next.delete(key);
        },
        setAlarm: async (at) => {
          next.set("alarm", at);
        },
        deleteAlarm: async () => {
          next.delete("alarm");
        },
      });
      this.data = next;
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
const owner = "a".repeat(64),
  other = "b".repeat(64);
const input = () => ({
  requestId: crypto.randomUUID(),
  purpose: "book-addition",
  modelId: "fixture",
  requestRaw: "{}",
  approvedPublicText: true,
  approvedMaxMilliYen: 1000,
  approvedQuoteDigest: "c".repeat(64),
});
const complete = () => ({
  status: "complete",
  account: owner,
  draft: {
    kind: "topic-textbook-draft",
    requestDigest: "d".repeat(64),
    draftDigest: "e".repeat(64),
    json: "{}",
    invocation: {
      id: crypto.randomUUID(),
      provider: "openai",
      model: "fixture",
    },
  },
});
function fixture(options = {}) {
  const storage = new Storage();
  let at = 1800000000000,
    calls = 0,
    lookups = 0;
  const settings = {
    enabled: true,
    now: () => at,
    run: async () => {
      calls++;
      return complete();
    },
    lookup: async () => {
      lookups++;
      return complete();
    },
    ...options,
  };
  return {
    storage,
    queue: new TopicJobQueue(storage, settings),
    restart: (extra = {}) =>
      new TopicJobQueue(storage, { ...settings, ...extra }),
    advance: (ms) => {
      at += ms;
    },
    calls: () => calls,
    lookups: () => lookups,
  };
}

test("予約とalarmを同時保存し、再起動後に処理し、同じ予約の再送では生成し直さない", async () => {
  const f = fixture(),
    command = input();
  const [a, b] = await Promise.all([
    f.queue.enqueue(owner, command),
    f.queue.enqueue(owner, command),
  ]);
  assert.equal(a.state, "queued");
  assert.deepEqual(a, b);
  assert.equal(f.calls(), 0);
  assert.equal(f.storage.data.get("alarm"), 1800000001000);
  await f.restart().alarm();
  const saved = await f.restart().read(owner, command.requestId);
  assert.equal(saved.state, "complete");
  assert.equal(saved.result.status, "complete");
  assert.equal(f.calls(), 1);
  assert.deepEqual(await f.queue.enqueue(owner, command), saved);
  await f.queue.alarm();
  assert.equal(f.calls(), 1);
  assert.equal(f.storage.data.has("alarm"), false);
});

test("同じIDで入力・モデル・費用承認を変える予約と他の所有者を拒否する", async () => {
  const f = fixture(),
    command = input();
  await f.queue.enqueue(owner, command);
  const before = structuredClone(f.storage.data);
  for (const changed of [
    { requestRaw: "changed" },
    { modelId: "another" },
    { approvedMaxMilliYen: 999 },
  ])
    await assert.rejects(
      f.queue.enqueue(owner, { ...command, ...changed }),
      /topic-job-conflict/,
    );
  await assert.rejects(f.queue.enqueue(other, input()), /topic-job-owner/);
  await assert.rejects(
    f.queue.read(other, command.requestId),
    /topic-job-owner/,
  );
  assert.deepEqual(f.storage.data, before);
  assert.equal(f.calls(), 0);
});

test("予約保存の失敗では処理も半端な予約も残さない", async () => {
  const f = fixture();
  f.storage.fail = true;
  await assert.rejects(f.queue.enqueue(owner, input()), /保存に失敗/);
  assert.equal(f.storage.data.size, 0);
  assert.equal(f.calls(), 0);
});

test("実行前に試行と回復予定を保存し、中断後は生成せず台帳を照会する", async () => {
  const f = fixture(),
    command = input();
  await f.queue.enqueue(owner, command);
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const runner = f.restart({
    run: async () => {
      assert.equal(
        (await f.storage.get("topic-jobs:record:" + command.requestId)).state,
        "running",
      );
      assert.equal(f.storage.data.get("alarm"), 1800000060000);
      entered();
      return waiting;
    },
  });
  const pending = runner.alarm();
  await started;
  const observing = await f
    .restart({
      lookup: async () => ({ status: "reserved", draft: null, account: owner }),
    })
    .refresh(owner, command.requestId);
  assert.equal(observing.state, "running");
  assert.equal(f.storage.data.get("alarm"), 1800000060000);
  f.advance(60001);
  await f.restart().alarm();
  assert.equal(f.calls(), 0);
  assert.equal(f.lookups(), 1);
  assert.equal(
    (await f.queue.read(owner, command.requestId)).state,
    "complete",
  );
  release({ status: "reserved", draft: null, account: owner });
  await pending;
  assert.equal(
    (await f.queue.read(owner, command.requestId)).state,
    "complete",
  );
});

test("生成後の保存失敗は再起動後の照会だけで回復し、二度目の生成を送らない", async () => {
  const f = fixture(),
    command = input();
  await f.queue.enqueue(owner, command);
  let sent = 0;
  const runner = f.restart({
    run: async () => {
      sent++;
      f.storage.fail = true;
      return complete();
    },
  });
  await assert.rejects(runner.alarm(), /保存に失敗/);
  f.storage.fail = false;
  f.advance(60001);
  await f.restart().alarm();
  assert.equal(sent, 1);
  assert.equal(f.calls(), 0);
  assert.equal(f.lookups(), 1);
  assert.equal(
    (await f.queue.read(owner, command.requestId)).state,
    "complete",
  );
});

test("台帳への反映前に照会しても拒否と断定せず、元の試行の遅い完了を回収する", async () => {
  const f = fixture(),
    command = input();
  await f.queue.enqueue(owner, command);
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const pending = f
    .restart({
      run: async () => {
        entered();
        return waiting;
      },
    })
    .alarm();
  await started;
  const observed = await f
    .restart({ lookup: async () => ({ status: "not-found", account: owner }) })
    .refresh(owner, command.requestId);
  assert.equal(observed.state, "running");
  assert.equal(f.storage.data.get("alarm"), 1800000060000);
  release(complete());
  await pending;
  assert.equal(
    (await f.queue.read(owner, command.requestId)).state,
    "complete",
  );
  assert.equal(f.calls(), 0);
});

test("結果不明・異なる所有者の応答・不正応答は保持し、自動再送しない", async () => {
  for (const response of [
    null,
    { ...complete(), account: other },
    { status: "unknown", draft: null, account: owner },
  ]) {
    let calls = 0;
    const f = fixture({
        run: async () => {
          calls++;
          if (!response) throw Error("通信切断");
          return response;
        },
      }),
      command = input();
    await f.queue.enqueue(owner, command);
    await f.queue.alarm();
    assert.equal((await f.queue.read(owner, command.requestId)).state, "held");
    await f.queue.enqueue(owner, command);
    f.advance(120000);
    await f.restart().alarm();
    assert.equal(calls, 1);
  }
});

test("大きな日本語入力と生成結果を値上限以内へ分割し、再起動後も同じ内容を読む", async () => {
  const result = complete();
  result.draft.json = JSON.stringify({ text: "教材".repeat(15000) });
  let received;
  const f = fixture({
    run: async (_owner, value) => {
      received = value;
      return result;
    },
  });
  const command = {
    ...input(),
    requestRaw: JSON.stringify({ text: "公開資料".repeat(18000) }),
  };
  await f.queue.enqueue(owner, command);
  await f.queue.alarm();
  assert.deepEqual(received, command);
  assert.deepEqual(
    (await f.restart().read(owner, command.requestId)).result,
    result,
  );
});

test("入力断片や保存形式の不整合を破壊せず拒否し、生成へ送らない", async () => {
  const f = fixture(),
    command = input();
  await f.queue.enqueue(owner, command);
  f.storage.data.set(`topic-jobs:input:${command.requestId}:0`, "{}");
  const healthy = input();
  await f.queue.enqueue(owner, healthy);
  await f.queue.alarm();
  assert.equal(
    (await f.queue.read(owner, command.requestId)).reason,
    "stored-input-unavailable",
  );
  assert.equal(
    f.storage.data.get(`topic-jobs:input:${command.requestId}:0`),
    "{}",
  );
  assert.equal(
    (await f.queue.read(owner, healthy.requestId)).state,
    "complete",
  );
  assert.equal(f.calls(), 1);
  f.storage.data.set("topic-jobs:index", {
    version: 99,
    owner,
    ids: [command.requestId],
  });
  const unknown = structuredClone(f.storage.data);
  await assert.rejects(f.queue.read(owner, command.requestId));
  assert.deepEqual(f.storage.data, unknown);
});

test("未知のジョブ1件を保持したまま他の予約を実行し、改変された結果を返さない", async () => {
  const f = fixture(),
    broken = input();
  await f.queue.enqueue(owner, broken);
  const unknown = { version: 99, future: "保持する" };
  f.storage.data.set("topic-jobs:record:" + broken.requestId, unknown);
  const command = input();
  await f.queue.enqueue(owner, command);
  await f.queue.alarm();
  assert.deepEqual(
    f.storage.data.get("topic-jobs:record:" + broken.requestId),
    unknown,
  );
  assert.equal(
    (await f.queue.list(owner)).jobs.find((job) => job.id === broken.requestId)
      .state,
    "unavailable",
  );
  const resultKey = `topic-jobs:result:${command.requestId}:0`;
  const modified = f.storage.data.get(resultKey).replace('"fixture"', '"改変"');
  f.storage.data.set(resultKey, modified);
  await assert.rejects(
    f.queue.read(owner, command.requestId),
    /topic-job-invalid/,
  );
  assert.equal(f.storage.data.get(resultKey), modified);
});

test("一時的な拒否は保留し、未送信の照会結果と新しい費用承認があるときだけ明示的に再予約する", async () => {
  for (const status of ["busy", "quote-changed", "credential-changed"]) {
    const received = [];
    const f = fixture({
        run: async (_owner, value) => {
          received.push(value);
          return received.length === 1
            ? { status, account: owner }
            : complete();
        },
        lookup: async () => ({ status: "not-found", account: owner }),
      }),
      command = input();
    await f.queue.enqueue(owner, command);
    await f.queue.alarm();
    assert.equal((await f.queue.read(owner, command.requestId)).state, "held");
    const renewed = {
      ...command,
      approvedMaxMilliYen: 1100,
      approvedQuoteDigest: "f".repeat(64),
    };
    await f.queue.retry(owner, renewed);
    await f.queue.alarm();
    assert.equal(
      (await f.queue.read(owner, command.requestId)).state,
      "complete",
    );
    assert.deepEqual(received, [command, renewed]);
  }
});

test("使用量不明や課金済みの失敗を再予約できず、確認済み未送信だけ同じIDで再開する", async () => {
  const command = input(),
    f = fixture({
      run: async () => ({ status: "unknown", draft: null, account: owner }),
    });
  await f.queue.enqueue(owner, command);
  await f.queue.alarm();
  const before = structuredClone(f.storage.data);
  for (const proof of [
    { status: "reserved", draft: null, account: owner },
    { status: "rejected", draft: null, account: owner },
    { status: "unknown", draft: null, account: owner },
  ]) {
    await assert.rejects(
      f.restart({ lookup: async () => proof }).retry(owner, command),
      /topic-job-retry-unavailable/,
    );
    assert.deepEqual(f.storage.data, before);
  }
  let sent;
  const confirmed = f.restart({
    lookup: async () => ({
      status: "rejected",
      retryable: true,
      draft: null,
      account: owner,
    }),
    run: async (_owner, value) => {
      sent = value;
      return complete();
    },
  });
  await confirmed.retry(owner, command);
  await confirmed.alarm();
  assert.equal(sent.retryUnsent, true);
  assert.equal(sent.requestId, command.requestId);
});

test("200件の完了済み控えを黙って消さず、明示的な削除で枠を空ける。実行待ち・不明の控えは消さない", async () => {
  const f = fixture(),
    first = input();
  await f.queue.enqueue(owner, first);
  await assert.rejects(
    f.queue.remove(owner, first.requestId),
    /topic-job-active/,
  );
  await f.queue.alarm();
  for (let n = 1; n < 200; n++) {
    await f.queue.enqueue(owner, input());
    await f.queue.alarm();
  }
  await assert.rejects(f.queue.enqueue(owner, input()), /topic-job-capacity/);
  await f.queue.remove(owner, first.requestId);
  assert.equal(await f.queue.read(owner, first.requestId), null);
  const next = input();
  assert.equal((await f.queue.enqueue(owner, next)).state, "queued");
  assert.equal(
    f.storage.data.has(`topic-jobs:input:${first.requestId}:0`),
    false,
  );
});

test("無効化しても予約と結果は保持し、新しい実行を始めない", async () => {
  const f = fixture(),
    command = input();
  await f.queue.enqueue(owner, command);
  const disabled = f.restart({ enabled: false });
  await disabled.alarm();
  assert.equal(f.calls(), 0);
  assert.equal((await disabled.read(owner, command.requestId)).state, "queued");
  await assert.rejects(
    disabled.enqueue(owner, input()),
    /topic-jobs-unconfigured/,
  );
});

test("保留した結果は明示的な照会だけで回収でき、待機一覧は結果本文を含めずページ分割する", async () => {
  let sends = 0;
  const f = fixture({
    run: async () => {
      sends++;
      throw Error("応答喪失");
    },
  });
  const ids = [];
  for (let n = 0; n < 21; n++) {
    const command = input();
    ids.push(command.requestId);
    await f.queue.enqueue(owner, command);
    await f.queue.alarm();
  }
  const first = await f.restart().list(owner);
  assert.deepEqual(
    first.jobs.map((job) => job.id),
    ids.toReversed().slice(0, 20),
  );
  assert.ok(first.jobs.every((job) => !Object.hasOwn(job, "result")));
  const last = await f.queue.list(owner, first.after);
  assert.deepEqual(
    last.jobs.map((job) => job.id),
    [ids[0]],
  );
  assert.equal(last.after, null);
  await assert.rejects(
    f.queue.list(owner, crypto.randomUUID()),
    /topic-job-cursor/,
  );
  const recovered = await f.queue.refresh(owner, ids[0]);
  assert.equal(recovered.state, "complete");
  assert.equal(sends, 21);
  assert.equal(f.lookups(), 1);
});

test("未処理の上限と費用未承認を拒否し、既存の予約を保持する", async () => {
  const f = fixture();
  const command = input();
  delete command.approvedQuoteDigest;
  await assert.rejects(f.queue.enqueue(owner, command), /cost-unapproved/);
  assert.equal(f.storage.data.size, 0);
  for (let n = 0; n < 20; n++) await f.queue.enqueue(owner, input());
  const before = structuredClone(f.storage.data);
  await assert.rejects(f.queue.enqueue(owner, input()), /topic-job-capacity/);
  assert.deepEqual(f.storage.data, before);
  assert.equal(f.calls(), 0);
});

test("不正な偽値の索引を未作成と見なして置き換えない", async () => {
  for (const value of [null, false, 0, ""]) {
    const f = fixture();
    f.storage.data.set("topic-jobs:index", value);
    const before = structuredClone(f.storage.data);
    await assert.rejects(f.queue.enqueue(owner, input()));
    await assert.rejects(f.queue.alarm());
    assert.deepEqual(f.storage.data, before);
    assert.equal(f.calls(), 0);
  }
});

test("無効化中に消えた予定をIDだけで再開でき、未実行の予約を取消して枠を空けられる", async () => {
  const f = fixture(),
    command = input();
  await f.queue.enqueue(owner, command);
  await f.restart({ enabled: false }).alarm();
  assert.equal(f.storage.data.has("alarm"), false);
  assert.equal(
    (await f.restart().resume(owner, command.requestId)).state,
    "queued",
  );
  assert.equal(f.storage.data.get("alarm"), 1800000001000);
  assert.equal(
    (await f.queue.cancel(owner, command.requestId)).state,
    "cancelled",
  );
  await f.restart().alarm();
  assert.equal(f.calls(), 0);
  await assert.rejects(
    f.queue.resume(owner, command.requestId),
    /topic-job-active/,
  );
  await f.queue.remove(owner, command.requestId);
  assert.equal(await f.queue.read(owner, command.requestId), null);
});
