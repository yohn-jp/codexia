import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export function validateOciEngine(value) {
  // Reject executable paths from the environment rather than executing them.
  if (value !== undefined && value !== "podman") {
    throw new Error("OCI_ENGINE must be the trusted Podman executable");
  }
  return "podman";
}

export function validateModelCachePath(value, fallback) {
  const configured = value ?? fallback;
  const resolved = resolve(configured);
  if (!isAbsolute(resolved) || /[:,\0\r\n]/u.test(resolved)) {
    throw new Error("CODEXIA_P13_MODEL_CACHE must resolve to a path without OCI mount delimiters");
  }
  return resolved;
}

export function validateImageReference(value, fallback) {
  const image = value ?? fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,254}$/u.test(image)) {
    throw new Error("CODEXIA_P13_IMAGE must be a local OCI image reference");
  }
  return image;
}

export async function isRealDirectory(path) {
  return (await lstat(path)).isDirectory();
}
