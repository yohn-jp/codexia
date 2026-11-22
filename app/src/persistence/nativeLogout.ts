import type { NativeSignOutResult } from "../../native/plugins/codexia-auth/src/index.mjs";

export type NativeLogoutAttempt =
  | { kind: "complete" }
  | { kind: "draft-unprotected" }
  | { kind: "local-clear-unconfirmed"; message: string }
  | { kind: "revocation-unconfirmed"; message: string }
  | { kind: "error"; message: string };

export async function attemptNativeLogout({
  protectDraft,
  blockWorkspace,
  signOut,
}: {
  protectDraft(): Promise<boolean>;
  blockWorkspace(): void;
  signOut(): Promise<NativeSignOutResult>;
}): Promise<NativeLogoutAttempt> {
  try {
    if (!await protectDraft()) return { kind: "draft-unprotected" };
  } catch {
    return { kind: "draft-unprotected" };
  }

  blockWorkspace();

  let result: NativeSignOutResult;
  try {
    result = await signOut();
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    return {
      kind: "error",
      message: `ネイティブログアウトの結果を確認できませんでした。端末の認証情報を消去できたか不明です。原稿を保護したままログアウトを再試行してください。${detail}`,
    };
  }

  if (result?.localCredentialsCleared !== true) {
    return {
      kind: "local-clear-unconfirmed",
      message: "端末の認証情報を消去できたか確認できませんでした。編集を停止しています。原稿を保護したままログアウトを再試行してください。",
    };
  }
  if (result.revoked !== true) {
    return {
      kind: "revocation-unconfirmed",
      message: "端末の認証情報は消去しましたが、サーバー側の失効を確認できませんでした。サーバー側の状態を確認してください。アプリを再利用する場合はネイティブ認証で再サインインしてください。",
    };
  }
  return { kind: "complete" };
}
