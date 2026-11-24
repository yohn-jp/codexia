import { prepareAuthorRuntime } from "./prepared-author-runtime.mjs";

void prepareAuthorRuntime().then(() => import("../../app/src/entries/mobile.tsx"));
