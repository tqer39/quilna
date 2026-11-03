import { DocumentReservations } from "./document-reservations.mjs";
import { documentIdentity } from "../src/source-document.ts";
import { sourceURL } from "../src/feed-discovery.ts";
import {
  documentAccess,
  documentRequest,
  documentError,
} from "./document-access.mjs";
import { json } from "./http.mjs";
import { DocumentPolicyAdmin } from "./document-policy-admin.mjs";
import {
  documentLifecycleAccess,
  lifecycleRequest,
} from "./document-lifecycle-access.mjs";

export class DocumentGateway {
  constructor(storage, env) {
    Object.assign(this, { storage, env });
  }
  get enabled() {
    return this.env.DOCUMENTS_ENABLED === "true" && !!this.env.DOCUMENTS;
  }
  async reserve(owner, url, audience, scope) {
    return new DocumentReservations(this.storage).reserve(
      owner,
      url,
      audience,
      scope,
    );
  }
  /** Resolve an administrative target and preserve body outcomes when accounting is unavailable. */
  async lifecycle(owner, action, data) {
    try {
      if (!this.enabled) throw Error("document-unconfigured");
      if (data && Object.hasOwn(data, "action"))
        throw Error("document-request");
      const input = lifecycleRequest.parse({ ...data, action });
      const options = { restore: input.command?.action === "restore" };
      const access = await documentLifecycleAccess(
        this.env,
        owner,
        input.target,
        options,
      );
      const id = await documentIdentity(access.scope, access.url);
      const response = await this.env.DOCUMENTS.get(
        this.env.DOCUMENTS.idFromName(id),
      ).fetch(
        new Request("https://document.internal/lifecycle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner,
            scope: access.scope,
            request:
              input.action === "reconcile"
                ? { action: "preview", target: input.target }
                : input,
          }),
        }),
      );
      const value = await response.json();
      const current = await documentLifecycleAccess(
        this.env,
        owner,
        input.target,
        options,
      );
      if (current.scope !== access.scope || current.url !== access.url)
        throw Error("document-unavailable");
      if (response.status !== 200)
        return json(response.status, { ...value, account: owner });
      const reservations = new DocumentReservations(this.storage);
      let reservation;
      if (input.action === "reconcile") {
        // Permanent deletion is stable even if a new generation is acquired while
        // awaiting this proof. The reservation token/revision protects that race.
        if (
          value.id !== id ||
          value.scope !== access.scope ||
          value.sourceURL !== access.url
        )
          throw Error("document-invalid");
        if (
          value.status !== "deleted" ||
          value.bytes !== 0 ||
          value.versionCount !== 0
        )
          throw Error("document-conflict");
        reservation = await reservations.releaseDeleted(
          owner,
          access.url,
          access.audience,
          access.scope,
          input.reservation,
        );
      } else {
        try {
          reservation = await reservations.inspect(
            owner,
            access.url,
            access.audience,
            access.scope,
          );
        } catch {
          // Accounting failure cannot erase an independently committed body decision.
          reservation = { status: "unavailable" };
        }
      }
      return json(
        200,
        input.action === "change"
          ? {
              ...value,
              current: { ...value.current, reservation },
              account: owner,
            }
          : { ...value, reservation, account: owner },
      );
    } catch (error) {
      const failure = documentError(error);
      return json(failure.code, { status: failure.status, account: owner });
    }
  }
  async handle(owner, action, data) {
    if (
      [
        "admin-document-preview",
        "admin-document-change",
        "admin-document-reconcile",
      ].includes(action)
    )
      return this.lifecycle(
        owner,
        action.slice("admin-document-".length),
        data,
      );
    if (action.startsWith("admin-"))
      return new DocumentPolicyAdmin(this.env).handle(owner, action, data);
    if (action === "status")
      return json(200, { account: owner, enabled: this.enabled });
    try {
      if (!this.enabled) throw Error("document-unconfigured");
      if (data && Object.hasOwn(data, "action"))
        throw Error("document-request");
      const input = documentRequest.parse({ ...data, action });
      const access = await documentAccess(
        this.env,
        owner,
        input.url,
        input.audience,
      );
      const reservation =
        action === "acquire"
          ? await this.reserve(owner, access.url, input.audience, access.scope)
          : undefined;
      const id = await documentIdentity(access.scope, access.url);
      const response = await this.env.DOCUMENTS.get(
        this.env.DOCUMENTS.idFromName(id),
      ).fetch(
        new Request("https://document.internal/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner,
            scope: access.scope,
            request: input,
          }),
        }),
      );
      // Check permission again before delivery, including cache hits/failures.
      // Revocation after this check cannot retract a response already authorized.
      const value = await response.json();
      const current = await documentAccess(
        this.env,
        owner,
        input.url,
        input.audience,
      );
      if (current.scope !== access.scope || current.url !== access.url)
        throw Error("document-unavailable");
      const { deletion, ...publicValue } = value;
      if (
        reservation &&
        response.status === 404 &&
        value.status === "document-unavailable" &&
        deletion?.id === id &&
        deletion.scope === access.scope &&
        deletion.sourceURL === access.url
      ) {
        // Undo only this request's new scope. A concurrent revision or storage
        // failure preserves the reservation for explicit management recovery.
        await new DocumentReservations(this.storage)
          .releaseDeleted(
            owner,
            access.url,
            input.audience,
            access.scope,
            reservation,
          )
          .catch(() => {});
      }
      return json(response.status, {
        ...publicValue,
        account: owner,
        ...(access.url !== sourceURL(input.url)
          ? {
              resolution: {
                requestedURL: sourceURL(input.url),
                sourceURL: access.url,
                scope: access.scope,
              },
            }
          : {}),
      });
    } catch (error) {
      const failure = documentError(error);
      return json(failure.code, { status: failure.status, account: owner });
    }
  }
}
