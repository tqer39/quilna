import { z } from "zod";
import { topicQuoteSchema } from "../src/topic-generation-protocol.ts";
import { topicCreationPayloads } from "../src/topic-creation-protocol.ts";
export {
  topicCreationPayloads,
  topicCreationDispatches,
} from "../src/topic-creation-protocol.ts";
export const topicCreationCommandSchema = z.discriminatedUnion(
  "action",
  Object.entries(topicCreationPayloads).map(([action, payload]) =>
    (["approve", "retry", "review-again"].includes(action)
      ? payload.extend({ currentQuotes: z.array(topicQuoteSchema).max(40) })
      : payload
    ).extend({
      action: z.literal(action),
      owner: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
);
