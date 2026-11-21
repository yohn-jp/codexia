import { basename, isAbsolute, resolve } from "node:path";

export function validateOciEngine(value) {
  const engine = value ?? "podman";
  if (basename(engine) !== "podman" || /[\0\r\n]/u.test(engine)) {
    throw new Error("OCI_ENGINE must name an installed Podman executable");
  }
  return engine;
}

export function validateModelCachePath(value, fallback) {
  const configured = value ?? fallback;
  if (!isAbsolute(configured) || /[:,\0\r\n]/u.test(configured)) {
    throw new Error("CODEXIA_P13_MODEL_CACHE must be an absolute path without OCI mount delimiters");
  }
  return resolve(configured);
}

export function validateImageReference(value, fallback) {
  const image = value ?? fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,254}$/u.test(image)) {
    throw new Error("CODEXIA_P13_IMAGE must be a local OCI image reference");
  }
  return image;
}
