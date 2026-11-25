import {
  ownerSetupAuthorizePost,
  ownerSetupCompletePost,
  ownerSetupProfilePost,
  ownerSetupStatusGet,
} from "../generated/http/client";
import { ApiError } from "../api-error";

const SETUP_REQUEST = {
  credentials: "same-origin",
  cache: "no-store",
  redirect: "error",
  transport: { auth: "same-origin" },
} as const;
const TRANSACTION_HEADER = "x-codexia-setup-transaction";

export type OwnerSetupStatus =
  | { state: "setup-pending" | "waiting" | "expired" | "blocked" | "active" }
  | { state: "owner-enrolled"; clientsReady: boolean; sessionConfirmed?: boolean };

export class SetupError extends Error {
  constructor(readonly status: number) { super("Owner setup request failed"); }
}

function statusOf(error: unknown): never {
  if (error instanceof ApiError) throw new SetupError(error.status);
  throw error;
}

/** Read setup state over the anonymous, same-origin setup adapter. */
export async function getOwnerSetupStatus(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<OwnerSetupStatus> {
  let value: unknown;
  try {
    value = await ownerSetupStatusGet({
      ...SETUP_REQUEST,
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
      fetcher,
    });
  } catch (error) {
    statusOf(error);
  }
  if (!value || typeof value !== "object" || !("state" in value)) throw new SetupError(503);
  switch (value.state) {
    case "setup-pending":
    case "waiting":
    case "expired":
    case "blocked":
    case "active":
      return { state: value.state };
    case "owner-enrolled":
      if ("clientsReady" in value && typeof value.clientsReady === "boolean") {
        return { state: value.state, clientsReady: value.clientsReady };
      }
  }
  throw new SetupError(503);
}

async function transactionResult(value: unknown): Promise<string> {
  if (value && typeof value === "object" && "transaction" in value && typeof value.transaction === "string") {
    return value.transaction;
  }
  throw new SetupError(503);
}

/** Validate the one-time setup key and receive only a short-lived setup transaction. */
export async function authorizeOwnerSetup(key: string, fetcher: typeof fetch = fetch): Promise<string> {
  let value: unknown;
  try {
    value = await ownerSetupAuthorizePost({ key }, {
      ...SETUP_REQUEST,
      headers: { accept: "application/json" },
      fetcher,
    });
  } catch (error) {
    statusOf(error);
  }
  return transactionResult(value);
}

/** Advance the same setup transaction with the owner's chosen profile. */
export async function setOwnerSetupProfile(
  input: { name: string; email: string },
  transaction: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  let value: unknown;
  try {
    value = await ownerSetupProfilePost(input, {
      ...SETUP_REQUEST,
      headers: { accept: "application/json", [TRANSACTION_HEADER]: transaction },
      fetcher,
    });
  } catch (error) {
    statusOf(error);
  }
  return transactionResult(value);
}

/** Confirm the committed owner enrollment; the SETUP transaction stays short-lived. */
export async function completeOwnerSetup(transaction: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  try {
    return await ownerSetupCompletePost({}, {
      ...SETUP_REQUEST,
      headers: { accept: "application/json", [TRANSACTION_HEADER]: transaction },
      fetcher,
    });
  } catch (error) {
    statusOf(error);
  }
}

