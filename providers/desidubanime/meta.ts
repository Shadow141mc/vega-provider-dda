import { Info, Link, ProviderContext } from "../types";
import {
  BASE_URL,
  fetchEpisodePage,
  normalizeUrl,
  siteHeaders,
  stripHtml,
} from "./utils";

function readJsonLd($: any): any {
  let fallback: any = null;

  $('script[type="application/ld+json"]').each((_: any, element: any) => {
    const raw = $(element).text().trim();
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      const candidates = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.["@graph"])
          ? parsed["@graph"]
          : [parsed];

      for (const candidate of candidates) {
        if (!fallback) fallback = candidate;
        const type = String(candidate?.["@type"] || "").toLowerCase();
        if (
          type.includes("movie") ||
          type.includes("tvseries") ||
          type.includes("anime")
        ) {
          fallback = candidate;
          return false;
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks and keep looking.
    }
  });

  return fallback || {};
}

function jsonLdImage(value: any): string {
  if (typeof value === "string") return normalizeUrl(value);
  if (Array.isArray(value) && value.length) return jsonLdImage(value[0]);
  if (value && typeof value === "object") {
    return jsonLdImage(value.url || value.contentUrl || value["@id"]);
  }
  return "";
}

function detailValue($: any, label: string): string {
  let value = "";
  $("dl dt").each((_: any, element: any) => {
    const key = stripHtml($(element).text()).toLowerCase();
    if (key === label.toLowerCase()) {
      value = stripHtml($(element).next("dd").text());
      return false;
    }
  });
  return value;
}

function seasonDisplayTitle(
  rawTitle: string,
  index: number,
  animeTitle: string,
): string {
  const title = stripHtml(rawTitle);
  if (!title) return `Season ${index + 1}`;
  if (title.toLowerCase() === animeTitle.toLowerCase()) return `Season ${index + 1}`;
  return title;
}

export const getMeta = async function ({
  link,
  providerContext,
}: {
  link: string;
  providerContext: ProviderContext;
}): Promise<Info> {
  const { axios, cheerio } = providerContext;
  const url = normalizeUrl(link);
  const response = await axios.get(url, { headers: siteHeaders() });
  const html = String(response.data || "");
  const $ = cheerio.load(html);
  const jsonLd = readJsonLd($);

  const rawTitle =
    jsonLd.name ||
    $("h1 .anime").first().text() ||
    $("h1").first().text() ||
    $("meta[property='og:title']").attr("content") ||
    "";
  const title = stripHtml(String(rawTitle))
    .replace(/\s*[-|]\s*Desi Dub Anime\s*$/i, "")
    .trim();

  const image =
    jsonLdImage(jsonLd.image) ||
    normalizeUrl($(".anime-main-image").first().attr("src") || "") ||
    normalizeUrl($("meta[property='og:image']").attr("content") || "");

  const overview = $('section[aria-label="Anime Overview"]').first().text();
  const jsonLdDescription = stripHtml(String(jsonLd.description || ""));
  const metaDescription = String(
    $("meta[name='description']").attr("content") || "",
  );
  const synopsis =
    stripHtml(overview) ||
    jsonLdDescription ||
    stripHtml(metaDescription);

  const ldType = String(jsonLd["@type"] || "").toLowerCase();
  const declaredType = detailValue($, "Type");
  const isMovie =
    ldType.includes("movie") || /^movie$/i.test(declaredType);
  const type = isMovie ? "movie" : "series";

  const rawGenres = jsonLd.genre;
  const tags = (
    Array.isArray(rawGenres)
      ? rawGenres
      : typeof rawGenres === "string"
        ? rawGenres.split(",")
        : []
  )
    .map((value: any) => stripHtml(String(value)))
    .filter(Boolean);

  const ratingValue = jsonLd?.aggregateRating?.ratingValue;
  const rating =
    ratingValue === undefined || ratingValue === null
      ? ""
      : String(ratingValue).trim();

  const imdbMatch =
    html.match(/imdb\.com\/title\/(tt\d{6,})/i) ||
    html.match(/\b(tt\d{6,})\b/);
  const imdbId = imdbMatch ? imdbMatch[1] : "";

  const seasons: { id: string; title: string }[] = [];
  const seenSeasons = new Set<string>();

  $("#seasonButtonsContainer button[data-season]").each(
    (_: any, element: any) => {
      const id = String($(element).attr("data-season") || "").trim();
      if (!id || seenSeasons.has(id)) return;
      seenSeasons.add(id);
      seasons.push({ id, title: stripHtml($(element).text()) });
    },
  );

  if (!seasons.length) {
    const fallbackId =
      String($("#seasonContent").attr("data-season") || "").trim() ||
      (html.match(/current_post_data_id\s*=\s*(\d+)/) || [])[1] ||
      "";
    if (fallbackId) {
      seasons.push({ id: fallbackId, title: "" });
    }
  }

  const linkList: Link[] = [];

  if (type === "movie") {
    let movieLink = "";
    let movieTitle = title;
    let movieImage = image;

    if (seasons.length) {
      try {
        const firstPage = await fetchEpisodePage(
          providerContext,
          seasons[0].id,
          1,
          "asc",
        );
        const episode = firstPage.episodes[0];
        if (episode?.url) {
          movieLink = normalizeUrl(episode.url);
          movieTitle = stripHtml(
            String(episode.post_title || episode.title || title),
          );
          movieImage = normalizeUrl(String(episode.thumbnail || image));
        }
      } catch {
        // Fall through to the slug-based watch URL below.
      }
    }

    if (!movieLink) {
      const slug = url.replace(/\/+$/, "").split("/").filter(Boolean).pop();
      if (slug) {
        movieLink = `${BASE_URL}/watch/${slug}-episode-1/`;
      }
    }

    if (movieLink) {
      linkList.push({
        title: "Movie",
        directLinks: [
          {
            title: movieTitle || "Play Movie",
            link: movieLink,
            type: "movie",
            image: movieImage,
          },
        ],
      });
    }
  } else {
    seasons.forEach((season, index) => {
      linkList.push({
        title: seasonDisplayTitle(season.title, index, title),
        episodesLink: season.id,
      });
    });
  }

  return {
    title,
    synopsis,
    image,
    imdbId,
    type,
    tags,
    rating,
    linkList,
    webUrl: url,
  };
};
