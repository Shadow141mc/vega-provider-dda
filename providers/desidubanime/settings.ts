import { ProviderContext, SettingsField } from "../types";

export const getSettingsSchema = async function ({
  providerContext,
}: {
  providerContext: ProviderContext;
}): Promise<SettingsField[]> {
  void providerContext;

  return [
    {
      key: "preferredQuality",
      type: "select",
      label: "Preferred Quality",
      description: "Default stream quality when multiple sources are available.",
      options: [
        { label: "Auto", value: "auto" },
        { label: "2160p", value: "2160" },
        { label: "1080p", value: "1080" },
        { label: "720p", value: "720" },
        { label: "480p", value: "480" },
      ],
      defaultValue: "auto",
    },
    {
      key: "preferredLanguage",
      type: "select",
      label: "Preferred Audio",
      description: "Choose the language to prefer when multiple dubbed/subbed options are available.",
      options: [
        { label: "Auto", value: "auto" },
        { label: "English", value: "en" },
        { label: "Hindi", value: "hi" },
        { label: "Japanese", value: "ja" },
      ],
      defaultValue: "auto",
    },
    {
      key: "autoSubtitles",
      type: "toggle",
      label: "Enable subtitles by default",
      description: "Turn on subtitles automatically when available.",
      defaultValue: true,
    },
    {
      key: "serverPreference",
      type: "select",
      label: "Preferred Server",
      description: "Bias the first returned source toward your preferred host.",
      options: [
        { label: "Auto", value: "auto" },
        { label: "Vidmoly", value: "vidmoly" },
        { label: "StreamRuby", value: "streamruby" },
      ],
      defaultValue: "auto",
    },
  ];
};
