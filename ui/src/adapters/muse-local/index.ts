import type { UIAdapterModule } from "../types";
import { parseMuseStdoutLine } from "@paperclipai/adapter-muse-local/ui";
import { MuseLocalConfigFields } from "./config-fields";
import { buildMuseLocalConfig } from "@paperclipai/adapter-muse-local/ui";

export const museLocalUIAdapter: UIAdapterModule = {
  type: "muse_local",
  label: "Muse",
  parseStdoutLine: parseMuseStdoutLine,
  ConfigFields: MuseLocalConfigFields,
  buildAdapterConfig: buildMuseLocalConfig,
};
