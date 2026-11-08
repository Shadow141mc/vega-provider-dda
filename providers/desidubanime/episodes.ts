import { EpisodeLink, ProviderContext } from "../types";
import {
  fetchEpisodePage,
  normalizeUrl,
  siteHeaders,
  stripHtml,
} from "./utils";

const PAGE_CONCURRENCY = 4;

async function resolveAnimeId(
  providerContext: ProviderContext,
  value: string,
): Promise<string> {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return raw;

  if (/^https?:\/\//i.test(raw)) {
    const { axios, cheerio } = providerContext;
    const response = await axios.get(raw, { headers: siteHeaders() });
    const html = String(response.data || "");
    const inlineId = html.match(/current_post_data_id\s*=\s*(\d+)/);
    if (inlineId) return inlineId[1];

    const $ = cheerio.load(html);
    const seasonId =
      String($("#seasonContent").attr("data-season") || "").trim() ||
      String(
        $("#seasonButtonsContainer button[data-season]").first().attr("data-season") ||
          "",
      ).trim();
    if (seasonId) return seasonId;
  }

  return "";
}

function episodeTitle(episode: any, position: number): string {
  const number =
    stripHtml(String(episode?.number || "")) || `Episode ${position + 1}`;
  const title = stripHtml(String(episode?.title || ""));
  if (!title || title.toLowerCase() === number.toLowerCase()) return number;
  return `${number}: ${title}`;
}

export const getEpisodes = async function ({
  url,
  providerContext,
}: {
  url: string;
  providerContext: ProviderContext;
}): Promise<EpisodeLink[]> {
  const animeId = await resolveAnimeId(providerContext, url);
  if (!animeId) return [];

  const firstPage = await fetchEpisodePage(
    providerContext,
    animeId,
    1,
    "asc",
  );
  const rawEpisodes = [...firstPage.episodes];

  const remainingPages: number[] = [];
  for (let page = 2; page <= firstPage.maxPages; page++) {
    remainingPages.push(page);
  }

  for (
    let index = 0;
    index < remainingPages.length;
    index += PAGE_CONCURRENCY
  ) {
    const chunk = remainingPages.slice(index, index + PAGE_CONCURRENCY);
    const pages = await Promise.all(
      chunk.map(page =>
        fetchEpisodePage(providerContext, animeId, page, "asc").catch(() => ({
          episodes: [],
          maxPages: page,
        })),
      ),
    );

    for (const page of pages) {
      rawEpisodes.push(...page.episodes);
    }
  }

  const seen = new Set<string>();
  const episodes: EpisodeLink[] = [];

  rawEpisodes.forEach((episode, index) => {
    if (!episode?.url) return;
    const link = normalizeUrl(episode.url);
    if (!link || seen.has(link)) return;
    seen.add(link);

    const description = [episode.released, episode.duration]
      .map(value => stripHtml(String(value || "")))
      .filter(Boolean)
      .join(" \u2022 ");

    episodes.push({
      title: episodeTitle(episode, index),
      link,
      description: description || undefined,
      image: normalizeUrl(String(episode.thumbnail || "")) || undefined,
    });
  });

  return episodes;
};
