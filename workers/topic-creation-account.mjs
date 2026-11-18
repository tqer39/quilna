import { z } from "zod";
import { json, readBody, principal } from "./http.mjs";
import {
  topicCreationPayloads,
  topicCreationDispatches,
} from "./topic-creation-commands.mjs";

/** 所有者と費用の正本はAccountに置き、ブラウザが現在見積りや所有者を注入できないようにする。 */
export async function handleTopicCreationAccount(core, request, creations) {
  if (
    request.method !== "POST" ||
    request.url !== "https://account.internal/command/topic-creations"
  )
    return json(404, { status: "not-found" });
  let owner;
  try {
    const command = z
      .object({
        action: z.string(),
        principal,
        csrf: z.string().max(200),
        data: z.unknown(),
      })
      .strict()
      .parse(await readBody(request, 400000));
    const action = command.action.startsWith("topic-creation-")
      ? command.action.slice("topic-creation-".length)
      : "";
    if (!Object.hasOwn(topicCreationPayloads, action))
      return json(400, { status: "invalid-request" });
    const data = topicCreationPayloads[action].parse(command.data);
    owner = await core.authorize(command.principal, command.csrf, true, {
      countRate: !["read", "list"].includes(action),
    });
    if (
      (action === "save" || topicCreationDispatches.has(action)) &&
      !(await creations?.canAuthor?.(owner))
    )
      throw Error("topic-author-forbidden");
    if (
      !creations?.binding ||
      (topicCreationDispatches.has(action) && !creations.enabled)
    )
      return json(503, {
        status: "topic-creations-unconfigured",
        account: owner,
      });
    const stub = creations.binding.get(creations.binding.idFromName(owner));
    const send = (value) =>
      stub.fetch(
        new Request("https://topic-creations.internal/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...value, owner }),
        }),
      );
    if (action === "save") {
      if (!creations.verifyMaterials)
        throw Error("topic-materials-unconfigured");
      await creations.verifyMaterials(owner, data.requestRaw);
    }
    let currentQuotes;
    if (["approve", "retry", "review-again"].includes(action)) {
      const response = await send({ action: "read", id: data.id });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw Error("topic-creation-conflict");
      }
      const saved = await readBody(response, 1048576);
      if (saved.account === owner && saved.creation === null)
        throw Error("topic-creation-missing");
      if (
        saved.account !== owner ||
        saved.creation?.id !== data.id ||
        saved.creation?.revision !== data.expectedRevision ||
        typeof saved.creation?.requestRaw !== "string"
      )
        throw Error("topic-creation-conflict");
      if (
        (action === "approve" && !!saved.creation.quotes) ||
        (action === "review-again" &&
          saved.creation.reviewRequestId === data.reviewRequestId)
      )
        currentQuotes = [];
      else {
        if (!creations.verifyMaterials)
          throw Error("topic-materials-unconfigured");
        await creations.verifyMaterials(owner, saved.creation.requestRaw);
        currentQuotes = (await core.topicStatus(owner)).quotes;
      }
    }
    return send({
      action,
      ...data,
      ...(currentQuotes ? { currentQuotes } : {}),
    });
  } catch (error) {
    const statuses = {
      "csrf-invalid": 403,
      "owner-mismatch": 403,
      "topic-creation-owner": 403,
      "topic-author-forbidden": 403,
      "rate-limit": 429,
      "topic-creation-conflict": 409,
      "topic-creation-missing": 404,
      "topic-materials-invalid": 409,
      "topic-materials-request": 400,
      "document-unavailable": 409,
      "topic-materials-unconfigured": 503,
      "document-unconfigured": 503,
      "topic-materials-unavailable": 503,
      "body-limit": 413,
      "invalid-body": 400,
    };
    const status =
      statuses[error.message] ??
      (error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503);
    return json(status, {
      status: statuses[error.message]
        ? error.message
        : status === 400
          ? "invalid-request"
          : "topic-creation-unavailable",
      ...(owner ? { account: owner } : {}),
    });
  }
}
