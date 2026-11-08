import { ProviderContext } from "../types";

export const BASE_URL = "https://www.desidubanime.me";
export const WP_API = `${BASE_URL}/wp-json/wp/v2`;
export const AJAX_URL = `${BASE_URL}/wp-admin/admin-ajax.php`;
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Common headers for every request to the site. The user agent override is
 * important because the site's WordPress cache serves a stripped page to
 * unknown clients in some regions.
 */
export function siteHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${BASE_URL}/`,
    ...extra,
  };
}

const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Small dependency-free base64 decoder. The provider sandbox does not always
 * expose atob(), and provider bundles must not pull in Node buffer helpers.
 */
export function decodeBase64(value: string): string {
  const input = String(value || "").replace(/[^A-Za-z0-9+/=]/g, "");
  let output = "";
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "=") break;
    const index = BASE64_CHARS.indexOf(char);
    if (index < 0) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }

  return output;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "\u2026",
  laquo: "\u00ab",
  ldquo: "\u201c",
  lsquo: "\u2018",
  lt: "<",
  mdash: "\u2014",
  nbsp: " ",
  ndash: "\u2013",
  quot: '"',
  raquo: "\u00bb",
  rdquo: "\u201d",
  rsquo: "\u2019",
  sbquo: "\u201a",
  bdquo: "\u201e",
  times: "\u00d7",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
};

/** Decode HTML entities used by WordPress titles and excerpts. */
export function decodeEntities(value: string): string {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      try {
        return String.fromCodePoint(parseInt(code, 16));
      } catch {
        return _;
      }
    })
    .replace(/&#(\d+);/g, (_, code) => {
      try {
        return String.fromCodePoint(parseInt(code, 10));
      } catch {
        return _;
      }
    })
    .replace(/&([a-z][a-z0-9]+);/gi, (match, name) => {
      const decoded = NAMED_ENTITIES[String(name).toLowerCase()];
      return decoded === undefined ? match : decoded;
    });
}

/** Remove markup and normalize whitespace from a scraped text blob. */
export function stripHtml(value: string): string {
  return decodeEntities(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve protocol-relative, root-relative and escaped URLs. */
export function normalizeUrl(value: string): string {
  let url = String(value || "").trim();
  url = url.replace(/\\\//g, "/");
  url = url.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"');
  url = url.replace(/^['"]|['"]$/g, "");
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${BASE_URL}${url}`;
  return url;
}

/** Pick the best featured image exposed by the WordPress REST API. */
export function featuredImage(anime: any): string {
  const media = anime?._embedded?.["wp:featuredmedia"]?.[0];
  if (!media) return "";
  return (
    media.source_url ||
    media.media_details?.sizes?.large?.source_url ||
    media.media_details?.sizes?.medium_large?.source_url ||
    media.media_details?.sizes?.full?.source_url ||
    ""
  );
}

/** Map a caption label to a 2-letter language code for the Vega player. */
export function languageCode(label: string): string {
  const value = String(label || "").toLowerCase();
  if (value.includes("english") || /\ben\b/.test(value)) return "en";
  if (value.includes("hindi") || /\bhi\b/.test(value)) return "hi";
  if (value.includes("japanese") || /\bja\b/.test(value)) return "ja";
  if (value.includes("tamil") || /\bta\b/.test(value)) return "ta";
  if (value.includes("telugu") || /\bte\b/.test(value)) return "te";
  if (value.includes("bengali") || /\bbn\b/.test(value)) return "bn";
  if (value.includes("malayalam") || /\bml\b/.test(value)) return "ml";
  if (value.includes("kannada") || /\bkn\b/.test(value)) return "kn";
  if (value.includes("marathi") || /\bmr\b/.test(value)) return "mr";
  if (value.includes("urdu") || /\bur\b/.test(value)) return "ur";
  if (value.includes("spanish") || /\bes\b/.test(value)) return "es";
  if (value.includes("french") || /\bfr\b/.test(value)) return "fr";
  if (value.includes("german") || /\bde\b/.test(value)) return "de";
  if (value.includes("arabic") || /\bar\b/.test(value)) return "ar";
  return "en";
}

/**
 * Fetch a taxonomy term id by slug. WordPress REST filters need numeric ids,
 * and the ids are not guaranteed to remain stable across site migrations.
 */
export async function getTermId(
  providerContext: ProviderContext,
  taxonomy: string,
  slug: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const { axios } = providerContext;
  try {
    const response = await axios.get(
      `${WP_API}/${taxonomy}?slug=${encodeURIComponent(slug)}`,
      { headers: siteHeaders(), signal },
    );
    const terms = Array.isArray(response.data) ? response.data : [];
    return terms.length ? Number(terms[0].id) : null;
  } catch {
    return null;
  }
}

export type RawEpisode = {
  number?: string;
  thumbnail?: string;
  title?: string;
  duration?: string;
  released?: string;
  id?: number;
  url?: string;
  post_title?: string;
  meta_number?: string;
  anime_type?: string;
};

export type EpisodePage = {
  episodes: RawEpisode[];
  maxPages: number;
};

/**
 * Fetch one page of the Kiranime episode list. The site loads this through
 * WordPress admin-ajax, not through the public REST API.
 */
export async function fetchEpisodePage(
  providerContext: ProviderContext,
  animeId: string | number,
  page = 1,
  order: "asc" | "desc" = "asc",
  signal?: AbortSignal,
): Promise<EpisodePage> {
  const { axios } = providerContext;
  const response = await axios.get(AJAX_URL, {
    params: {
      action: "get_episodes",
      anime_id: animeId,
      page: Math.max(1, page || 1),
      order,
    },
    headers: siteHeaders(),
    signal,
  });

  const body = response?.data || {};
  const data = body?.data || body || {};
  const episodes: RawEpisode[] = Array.isArray(data.episodes)
    ? data.episodes
    : [];

  return {
    episodes,
    maxPages: Math.max(1, Number(data.max_episodes_page) || 1),
  };
}
