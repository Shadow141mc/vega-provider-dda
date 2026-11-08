import { ProviderContext, Stream, TextTracks } from "../types";
import { throwProviderError } from "../providerErrors";
import {
  BASE_URL,
  USER_AGENT,
  decodeBase64,
  languageCode,
  normalizeUrl,
  siteHeaders,
  stripHtml,
} from "./utils";

type ServerKind = "vidmoly" | "streamruby";

type EmbedCandidate = {
  label: string;
  link: string;
  kind: ServerKind;
  language: string;
};

/**
 * The site embeds its servers as base64 "label:payload" pairs. The payload is
 * usually a URL, but older episodes wrap an iframe in HTML instead.
 */
function decodeBase64Url(value: string): string {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  return decodeBase64(normalized);
}

function originOf(url: string): string {
  const match = String(url || "").match(/^https?:\/\/[^/]+/i);
  return match ? `${match[0]}/` : `${BASE_URL}/`;
}

function hostOf(url: string): string {
  return originOf(url)
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function classifyEmbed(label: string, link: string): ServerKind | null {
  const value = `${label} ${hostOf(link)}`.toLowerCase();
  if (value.includes("vidmoly") || /\bvmoly\b/.test(value)) return "vidmoly";
  if (/nuvorel|streamruby|sruby/.test(value)) return "streamruby";
  return null;
}

function extractEmbedLink(payload: string): string {
  const decoded = decodeBase64Url(payload).trim();
  if (!decoded) return "";
  if (/^https?:\/\//i.test(decoded) || decoded.startsWith("//")) {
    return normalizeUrl(decoded);
  }

  const iframe = decoded.match(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (iframe) return normalizeUrl(iframe[1]);

  const source = decoded.match(/(?:src|data-src)\s*=\s*["']([^"']+)["']/i);
  if (source) return normalizeUrl(source[1]);

  const url = decoded.match(/https?:\/\/[^\s"'<>]+/i);
  return url ? normalizeUrl(url[0]) : "";
}

function unescapeJs(value: string): string {
  return String(value || "")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"');
}

function extractSource(html: string): string {
  const text = unescapeJs(html);
  const patterns = [
    /sources\s*[:=]\s*\[[\s\S]{0,4000}?["']?file["']?\s*:\s*["']([^"']+)["']/i,
    /["']sources["']\s*:\s*\[[\s\S]{0,4000}?["']file["']\s*:\s*["']([^"']+)["']/i,
    /(https?:\/\/[^"'\s<>\\]+?\.m3u8[^"'\s<>\\]*)/i,
    /(https?:\/\/[^"'\s<>\\]+?\.mp4[^"'\s<>\\]*)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return normalizeUrl(match[1]);
  }

  return "";
}

function extractSubtitles(html: string): TextTracks {
  const text = unescapeJs(html);
  const tracks: TextTracks = [];
  const seen = new Set<string>();
  const objectPattern = /\{[^{}]*\.(?:vtt|srt)(?:\?[^"'{}]*)?[^{}]*\}/gi;
  let objectMatch: RegExpExecArray | null;

  while ((objectMatch = objectPattern.exec(text))) {
    const block = objectMatch[0];
    const fileMatch =
      block.match(/["']?file["']?\s*:\s*["']([^"']+)["']/i) ||
      block.match(/["']?src["']?\s*:\s*["']([^"']+)["']/i);
    if (!fileMatch?.[1]) continue;

    const kindMatch = block.match(/["']?kind["']?\s*:\s*["']([^"']+)["']/i);
    const kind = String(kindMatch?.[1] || "captions").toLowerCase();
    if (kind !== "captions" && kind !== "subtitles") continue;

    const uri = normalizeUrl(fileMatch[1]);
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);

    const labelMatch = block.match(/["']?label["']?\s*:\s*["']([^"']*)["']/i);
    const label = stripHtml(String(labelMatch?.[1] || ""));
    const language = languageCode(label || uri);
    const title =
      label || (language === "en" ? "English" : language.toUpperCase());

    tracks.push({
      title,
      language,
      type: /\.srt(?:\?|$)/i.test(uri) ? "application/x-subrip" : "text/vtt",
      uri,
    });
  }

  return tracks;
}

function guessStreamType(url: string): string {
  const clean = String(url || "").split("?")[0];
  return /\.mp4$/i.test(clean) ? "mp4" : "m3u8";
}

function directStream(link: string): Stream | null {
  const url = normalizeUrl(link);
  const clean = url.split("?")[0];
  if (!/\.(m3u8|mp4)$/i.test(clean)) return null;
  return {
    server: "Direct",
    link: url,
    type: guessStreamType(url),
  };
}

async function detectQuality(
  providerContext: ProviderContext,
  source: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  if (guessStreamType(source) !== "m3u8") return "";

  try {
    const response = await providerContext.axios.get(source, { headers, signal });
    const text = String(response.data || "");
    const pattern = /RESOLUTION=\d+x(\d+)/gi;
    let match: RegExpExecArray | null;
    let height = 0;

    while ((match = pattern.exec(text))) {
      const value = Number(match[1]);
      if (value > height) height = value;
    }

    if (!height) {
      const labelMatch = text.match(/["']?(\d{3,4})p(?:\s*HD)?["']?/i);
      if (labelMatch) height = Number(labelMatch[1]);
    }

    return height ? `${height}p` : "";
  } catch {
    return "";
  }
}

async function resolveEmbed(
  providerContext: ProviderContext,
  candidate: EmbedCandidate,
  signal?: AbortSignal,
): Promise<Stream | null> {
  const { axios } = providerContext;

  // StreamRuby tokens are tied to the request header set that fetched the
  // embed page. Keep this header set small, then reuse the exact same headers
  // for the master playlist and for playback.
  const headers = {
    "User-Agent": USER_AGENT,
    Referer: `${BASE_URL}/`,
  };

  const response = await axios.get(candidate.link, {
    headers,
    signal,
  });
  const html = String(response.data || "");
  const source = extractSource(html);
  if (!source) return null;

  const quality = await detectQuality(providerContext, source, headers, signal);
  const subtitles = extractSubtitles(html);

  return {
    server: candidate.kind === "vidmoly" ? "Vidmoly" : "StreamRuby",
    link: source,
    type: guessStreamType(source),
    quality: quality || undefined,
    subtitles: subtitles.length ? subtitles : undefined,
    headers,
    tag: candidate.language || undefined,
    tags: candidate.language ? [candidate.language] : undefined,
  };
}

function watchPageCandidates($: any): {
  candidates: EmbedCandidate[];
  allLabels: string[];
} {
  const candidates: EmbedCandidate[] = [];
  const allLabels: string[] = [];
  const seen = new Set<string>();
  const seenLabels = new Set<string>();

  $("[data-embed-id]").each((_: any, element: any) => {
    const raw = String($(element).attr("data-embed-id") || "");
    if (!raw) return;

    const separator = raw.indexOf(":");
    const label = stripHtml(
      decodeBase64Url(separator >= 0 ? raw.slice(0, separator) : ""),
    );
    const payload = separator >= 0 ? raw.slice(separator + 1) : raw;
    const link = extractEmbedLink(payload);
    if (!link) return;

    if (label && !seenLabels.has(label)) {
      seenLabels.add(label);
      allLabels.push(label);
    }
    const kind = classifyEmbed(label, link);
    if (!kind) return;

    let language = "";
    const group = $(element).closest(".player-selection");
    if (group.hasClass("player-sub")) language = "SUB";
    else if (group.hasClass("player-dub")) language = "DUB";

    const key = `${kind}:${link}`;
    if (seen.has(key)) return;
    seen.add(key);

    candidates.push({ label, link, kind, language });
  });

  return { candidates, allLabels };
}

export const getStream = async function ({
  link,
  type,
  signal,
  providerContext,
  isDownload,
}: {
  link: string;
  type: string;
  signal?: AbortSignal;
  providerContext: ProviderContext;
  isDownload?: boolean;
}): Promise<Stream[]> {
  void type;
  const input = normalizeUrl(link);

  const direct = directStream(input);
  if (direct) return [direct];

  // The caller may hand us an embed URL directly (for example from a
  // previous version of the catalog).
  const inputKind = classifyEmbed("", input);
  if (inputKind) {
    const stream = await resolveEmbed(
      providerContext,
      { label: "", link: input, kind: inputKind, language: "" },
      signal,
    );
    if (stream) return [stream];
    throw new Error(
      "DesiDubAnime: found a Vidmoly/StreamRuby embed but could not extract a playable HLS URL.",
    );
  }

  let html = "";
  let $: any;

  try {
    const response = await providerContext.axios.get(input, {
      headers: siteHeaders(),
      signal,
    });
    html = String(response.data || "");
    $ = providerContext.cheerio.load(html);
  } catch (error) {
    throwProviderError("DesiDubAnime", "getStream", error);
  }

  const { candidates, allLabels } = watchPageCandidates($);

  const results = await Promise.all(
    candidates.map(candidate =>
      resolveEmbed(providerContext, candidate, signal).catch(() => null),
    ),
  );

  const seenLinks = new Set<string>();
  const streams = results.filter((stream): stream is Stream => {
    if (!stream?.link) return false;
    if (seenLinks.has(stream.link)) return false;
    seenLinks.add(stream.link);
    return true;
  });

  if (!streams.length) {
    // A few pages still put a direct HLS source straight into the watch page.
    const fallbackSource = extractSource(html);
    if (fallbackSource) {
      const fallbackHeaders = siteHeaders();
      const quality = await detectQuality(
        providerContext,
        fallbackSource,
        fallbackHeaders,
        signal,
      );
      const subtitles = extractSubtitles(html);
      return [
        {
          server: "DesiDubAnime",
          link: fallbackSource,
          type: guessStreamType(fallbackSource),
          quality: quality || undefined,
          subtitles: subtitles.length ? subtitles : undefined,
          headers: fallbackHeaders,
        },
      ];
    }

    if (allLabels.length) {
      throw new Error(
        `No supported stream. This episode only offers: ${allLabels.join(
          ", ",
        )}. DesiDubAnime currently supports Vidmoly and StreamRuby.`,
      );
    }

    throw new Error(
      "No video servers were found on this episode page. DesiDubAnime currently supports Vidmoly and StreamRuby.",
    );
  }

  // Vidmoly 16:9 masters usually expose the highest bitrate; keep it first so
  // the app's quick play/download buttons pick the better quality.
  streams.sort((a, b) => {
    if (isDownload) {
      const qualityA = parseInt(String(a.quality || ""), 10) || 0;
      const qualityB = parseInt(String(b.quality || ""), 10) || 0;
      if (qualityA !== qualityB) return qualityB - qualityA;
    }
    const rank = (stream: Stream) => (stream.server === "Vidmoly" ? 0 : 1);
    return rank(a) - rank(b);
  });

  return streams;
};
