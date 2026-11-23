export function shouldProtectBeforeUnload(input: {
  isComposing: boolean;
  dirty: boolean;
  recovery: "pending" | "stored" | "failed" | "other-tab";
  unsafeUndo: boolean;
}): boolean {
  return input.isComposing || (input.dirty && input.recovery !== "stored") || input.unsafeUndo;
}
