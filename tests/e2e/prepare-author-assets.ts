import { prepareAuthorBrowserAssetTemplate } from "./oauth-asset-template";

const profile = process.env.CODEXIA_PROFILE;
const directory = process.env.CODEXIA_E2E_AUTH_ASSET_TEMPLATE;
if (!profile || !directory) {
  throw new Error("Set CODEXIA_PROFILE and CODEXIA_E2E_AUTH_ASSET_TEMPLATE before preparing OAuth assets");
}
prepareAuthorBrowserAssetTemplate(profile, directory);
