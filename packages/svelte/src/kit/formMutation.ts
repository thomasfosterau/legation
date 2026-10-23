/**
 * Form-action Mutations (ADR-0030, amendment #215)
 *
 * A SvelteKit form action that can name the client group runs a named
 * Mutation as one of that group's mutations, under a **form client** id
 * minted for the rendered form with mutation id `1`. The mechanism is core
 * (`Server.mutate`); this module adds only what binds to SvelteKit:
 *
 * - Server: {@link mintFormClient} for the page that renders the form,
 *   {@link formMutationTarget} to read the group cookie and the posted
 *   form-client fields, and {@link runFormMutation} to hand the form layer's
 *   decoded args to `Server.mutate`. The action returns the receipt under
 *   {@link RECEIPT_KEY}.
 * - Client: {@link enhanceFormMutation}, the enhanced submit for `use:enhance`.
 *   It overlays the Mutation's effect under a fresh form client, then settles
 *   on the receipt: acknowledged moves it to the unpulled tail until the pull
 *   that covers it, rejected drops it.
 *
 * An action that cannot name the group (no cookie) is not routed here: it
 * stays an out-of-band writer (ADR-0020, amended), committing through the
 * app's API and announcing the change with `Server.broadcast`.
 *
 * One path per write: a page writes a submission either through its form
 * action (this module) or through a façade write (#169, ADR-0030 §1–§2),
 * never both for the same submission, or the write would be applied twice.
 */
import type { Cookies } from "@sveltejs/kit";
import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import {
  Client,
  type Mutation,
  type Server,
  type TransportError,
  type VersionNotSupportedError,
} from "@thomasfosterau/legation-effect";
import type { ClientRuntime } from "../Runtime.js";
import { CLIENT_GROUP_COOKIE } from "./clientGroup.js";

/** The hidden field carrying the rendered form's form client id. */
export const FORM_CLIENT_FIELD = "legation-form-client";
/** The hidden field carrying the form client's mutation id. */
export const FORM_MUTATION_FIELD = "legation-form-mutation";
/** The key of the action result's data under which the receipt travels. */
export const RECEIPT_KEY = "legationReceipt";

/** A form client: the id minted for one rendered form, and its mutation id (`1`). */
export interface FormClient {
  readonly clientId: string;
  readonly mutationId: number;
}

/**
 * Mint a form client for one rendered form: a fresh id with mutation id `1`
 * (ADR-0030 #215 §2). The page's server `load` mints one per form and renders
 * it in the {@link FORM_CLIENT_FIELD} and {@link FORM_MUTATION_FIELD} hidden
 * fields, so a resubmission of the same rendered form is the same mutation.
 */
export const mintFormClient = (generate: () => string = () => crypto.randomUUID()): FormClient => ({
  clientId: `form-${generate()}`,
  mutationId: 1,
});

/** The form client a posted form names, or `undefined` when its fields are missing or malformed. */
export const formClientOf = (data: FormData): FormClient | undefined => {
  const clientId = data.get(FORM_CLIENT_FIELD);
  const mutationId = Number(data.get(FORM_MUTATION_FIELD));
  return P.isString(clientId) && clientId !== "" && Number.isInteger(mutationId) && mutationId >= 1
    ? { clientId, mutationId }
    : undefined;
};

/** Where a form action's Mutation runs: the client group and the form client. */
export interface FormMutationTarget extends FormClient {
  readonly clientGroupId: string;
}

/** Options for {@link formMutationTarget}. */
export interface FormMutationTargetOptions {
  /** The client-group cookie's name. Default `"legation-client-group"`, as `clientGroupId` uses. */
  readonly cookieName?: string | undefined;
}

/**
 * Read where a form action's Mutation runs: the client group from its cookie
 * (never minted here) and the form client from the posted fields. `undefined`
 * means the action cannot name the group or the form: it stays an out-of-band
 * writer.
 */
export const formMutationTarget = (
  cookies: Cookies,
  data: FormData,
  options?: FormMutationTargetOptions
): FormMutationTarget | undefined => {
  const group = cookies.get(options?.cookieName ?? CLIENT_GROUP_COOKIE);
  const form = formClientOf(data);
  return group === undefined || group === "" || form === undefined
    ? undefined
    : { clientGroupId: group, ...form };
};

/**
 * Run the form layer's decoded args as the target's Mutation on the server
 * (`Server.mutate`) and answer the receipt. Return it from the action as
 * `{ [RECEIPT_KEY]: receipt }`, so the enhanced submit settles on it; a
 * rejected receipt's `reason` is the form layer's to route to a message.
 * Args that do not fit the Mutation's schema are a defect, not a field error.
 */
export const runFormMutation = <Args, ArgsEncoded>(
  server: Server.Server,
  target: FormMutationTarget,
  mutation: Mutation.Mutator<string, Args, ArgsEncoded>,
  args: Args
): Effect.Effect<Server.Receipt, TransportError | VersionNotSupportedError> =>
  server.mutate({
    clientGroupId: target.clientGroupId,
    clientId: target.clientId,
    mutationId: target.mutationId,
    mutation,
    args,
  });

/**
 * The part of SvelteKit's `ActionResult` (from `$app/forms`) read here: its
 * type, and the data a `success` or `failure` result carries.
 */
export interface FormActionResult {
  readonly type: string;
  readonly data?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The submit function {@link enhanceFormMutation} returns, typed by the parts
 * of SvelteKit's `SubmitFunction` it uses, so it can be passed to `enhance`.
 */
export type FormSubmitFunction = (input: {
  readonly formData: FormData;
}) => (opts: {
  readonly result: FormActionResult;
  readonly update: (options?: { refreshAll?: boolean }) => Promise<void>;
}) => Promise<void>;

/** The receipt an action result carries under {@link RECEIPT_KEY}, or `undefined`. */
export const receiptOf = (result: FormActionResult): Server.Receipt | undefined => {
  if (result.type !== "success" && result.type !== "failure") return undefined;
  const receipt: unknown = result.data?.[RECEIPT_KEY];
  if (
    !P.hasProperty(receipt, "clientId") ||
    !P.hasProperty(receipt, "mutationId") ||
    !P.hasProperty(receipt, "phase") ||
    !P.isString(receipt.clientId) ||
    !P.isNumber(receipt.mutationId) ||
    (receipt.phase !== "acknowledged" && receipt.phase !== "rejected")
  ) {
    return undefined;
  }
  if (receipt.phase === "acknowledged") {
    return { clientId: receipt.clientId, mutationId: receipt.mutationId, phase: "acknowledged" };
  }
  const reason =
    P.hasProperty(receipt, "reason") && P.isString(receipt.reason) ? receipt.reason : "";
  return { clientId: receipt.clientId, mutationId: receipt.mutationId, phase: "rejected", reason };
};

/** Options for {@link enhanceFormMutation}. */
export interface EnhanceFormMutationOptions<Args, ArgsEncoded> {
  /** The Mutation the form's action runs. */
  readonly mutation: Mutation.Mutator<string, Args, ArgsEncoded>;
  /** The Mutation's args, read from the submitted form data (the form layer's decode). */
  readonly args: (data: FormData) => Args;
  /**
   * Re-run the page's `load` functions after the action, SvelteKit's default.
   * Default `false`: the overlay already shows the write, and the pull that
   * covers it brings the confirmed rows (ADR-0030 #215 §4).
   */
  readonly refreshAll?: boolean | undefined;
  /** Mint the per-submit form client id. Default `crypto.randomUUID`. */
  readonly generate?: (() => string) | undefined;
  /** Called with the receipt once the submission settles, e.g. to show a rejection's reason. */
  readonly onReceipt?: ((receipt: Server.Receipt) => void) | undefined;
}

/**
 * The enhanced submit for a form-action Mutation: pass it to SvelteKit's
 * `use:enhance`. Each submit mints a fresh form client and writes it into the
 * posted fields, overlays the Mutation's local effect under it without
 * journaling it (the action delivers it), and settles on the receipt the
 * action returns under {@link RECEIPT_KEY}: acknowledged moves the effect to
 * the unpulled tail, where the pull that covers the form client releases it;
 * rejected drops it. A result without a receipt (an error, a redirect, a
 * failed network) abandons the effect, and the next pull shows the server's
 * state. While offline the submit fails as the network fails (ADR-0030 open
 * point 6).
 */
export const enhanceFormMutation =
  <Args, ArgsEncoded>(
    runtime: ClientRuntime,
    options: EnhanceFormMutationOptions<Args, ArgsEncoded>
  ): FormSubmitFunction =>
  ({ formData }) => {
    const form = mintFormClient(options.generate);
    formData.set(FORM_CLIENT_FIELD, form.clientId);
    formData.set(FORM_MUTATION_FIELD, String(form.mutationId));
    const begun = runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* Client.Client;
        return yield* client.beginFormMutation(form, options.mutation.name, options.args(formData));
      })
    );
    return async ({ result, update }) => {
      const submission = await begun;
      const receipt = receiptOf(result);
      await runtime.runPromise(
        receipt === undefined ? submission.abandon : submission.settle(receipt).pipe(Effect.orDie)
      );
      if (receipt !== undefined) options.onReceipt?.(receipt);
      await update({ refreshAll: options.refreshAll ?? false });
    };
  };
