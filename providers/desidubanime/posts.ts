import { Post, ProviderContext } from "../types";
import {
  BASE_URL,
  WP_API,
  decodeEntities,
  featuredImage,
  getTermId,
  siteHeaders,
  stripHtml,
} from "./utils";

const PER_PAGE = 24;

function mapAnime(anime: any): Post {
  return {
    title: stripHtml(anime?.title?.rendered || ""),
    link: String(anime?.link || ""),
    image: featuredImage(anime),
  };
}

function uniquePosts(posts: Post[]): Post[] {
  const seen = new Set<string>();
  return posts.filter(post => {
    if (!post.link || seen.has(post.link)) return false;
    seen.add(post.link);
    return true;
  });
}

function firstText(
  $: any,
  element: any,
  selector: string,
): string {
  const node = $(element).find(selector).first();
  if (!node.length) return "";
  const span = node.find("span").first();
  const value = span.length ? span.text() : node.text();
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

function parseInfoLink($: any, element: any): string {
  const withInfo = $(element)
    .find("[onclick*='/anime/'], [onclick*=\"/anime/\"]")
    .first();
  const onclick = withInfo.attr("onclick") || "";
  const match = onclick.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
  if (match) return match[1];

  const anchor = $(element).find('a[href*="/anime/"]').first();
  return anchor.attr("href") || "";
}

async function fetchHomePosts(
  providerContext: ProviderContext,
  heading: string,
  signal: AbortSignal,
): Promise<Post[]> {
  const { axios, cheerio } = providerContext;
  const response = await axios.get(`${BASE_URL}/`, {
    headers: siteHeaders(),
    signal,
  });
  const $ = cheerio.load(String(response.data || ""));

  const headingNode = $("h2")
    .filter((_, element) => {
      return (
        $(element).text().replace(/\s+/g, " ").trim().toLowerCase() ===
        heading.toLowerCase()
      );
    })
    .first();

  if (!headingNode.length) return [];

  const section = headingNode.closest("section");
  const root = section.length ? section : headingNode.parent().parent();
  const posts: Post[] = [];

  root.find("article.anime-card").each((_, element) => {
    const link = parseInfoLink($, element);
    if (!link) return;
    const image =
      $(element).find("img").first().attr("src") ||
      $(element).find("img").first().attr("data-src") ||
      "";
    posts.push({
      title: firstText($, element, "h3"),
      link,
      image,
    });
  });

  if (posts.length) return uniquePosts(posts);
  return [];
}

async function fetchPopularPosts(
  providerContext: ProviderContext,
  signal: AbortSignal,
): Promise<Post[]> {
  const { axios, cheerio } = providerContext;
  const response = await axios.get(`${BASE_URL}/`, {
    headers: siteHeaders(),
    signal,
  });
  const $ = cheerio.load(String(response.data || ""));

  const widget = $("#popularWidget");
  if (!widget.length) return [];

  // The first list is the "Day" tab; subsequent ones are week and month.
  const list = widget.find("ul").first();
  const posts: Post[] = [];

  list.find("li").each((_, element) => {
    const anchor = $(element).find('a[href*="/anime/"]').first();
    const link = anchor.attr("href") || "";
    if (!link) return;

    const image = $(element).find("img").first().attr("src") || "";
    const title =
      $(element).attr("aria-label") ||
      firstText($, element, "h3") ||
      anchor.attr("title") ||
      "";

    posts.push({
      title: decodeEntities(String(title)).replace(/\s+/g, " ").trim(),
      link,
      image,
    });
  });

  return uniquePosts(posts);
}

async function fetchAnimeList({
  providerContext,
  filter,
  page,
  signal,
}: {
  providerContext: ProviderContext;
  filter: string;
  page: number;
  signal: AbortSignal;
}): Promise<Post[]> {
  const { axios } = providerContext;
  const params: Record<string, string | number> = {
    per_page: PER_PAGE,
    page: Math.max(1, page || 1),
    _embed: "wp:featuredmedia",
    orderby: "date",
    order: "desc",
  };

  let normalizedFilter = String(filter || "").trim();

  // Accept both our "genre:action" filters and raw "/genre/action" values.
  if (normalizedFilter.startsWith("/genre/")) {
    normalizedFilter = `genre:${normalizedFilter.replace(/^\/genre\//, "").replace(/\/+$/, "")}`;
  }

  if (normalizedFilter === "updated") {
    params.orderby = "modified";
  } else if (normalizedFilter.startsWith("genre:")) {
    const slug = normalizedFilter.slice("genre:".length);
    const termId = await getTermId(providerContext, "genre", slug, signal);
    if (!termId) return [];
    params.genre = termId;
  } else if (normalizedFilter === "movie" || normalizedFilter === "tv") {
    const termId = await getTermId(
      providerContext,
      "anime_type",
      normalizedFilter,
      signal,
    );
    if (!termId) return [];
    params.anime_type = termId;
  } else if (normalizedFilter === "ona" || normalizedFilter === "ova") {
    const termId = await getTermId(
      providerContext,
      "anime_type",
      normalizedFilter,
      signal,
    );
    if (!termId) return [];
    params.anime_type = termId;
  }

  try {
    const response = await axios.get(`${WP_API}/anime`, {
      params,
      headers: siteHeaders(),
      signal,
    });
    const data = Array.isArray(response.data) ? response.data : [];
    return uniquePosts(data.map(mapAnime));
  } catch (error: any) {
    // WordPress returns 400 once the requested page is past the last page.
    if (error?.response?.status === 400) return [];
    throw error;
  }
}

export const getPosts = async function ({
  filter,
  page,
  providerValue,
  signal,
  providerContext,
}: {
  filter: string;
  page: number;
  providerValue: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  void providerValue;

  if (filter === "popular") {
    if (page > 1) return [];
    return fetchPopularPosts(providerContext, signal);
  }

  if (filter === "latest-episodes") {
    if (page > 1) return [];
    const posts = await fetchHomePosts(providerContext, "Latest Episode", signal);
    if (posts.length) return posts;
    // Fall back to the recently-updated list if the homepage markup changes.
    return fetchAnimeList({
      providerContext,
      filter: "updated",
      page,
      signal,
    });
  }

  return fetchAnimeList({
    providerContext,
    filter,
    page,
    signal,
  });
};

export const getSearchPosts = async function ({
  searchQuery,
  page,
  providerValue,
  signal,
  providerContext,
}: {
  searchQuery: string;
  page: number;
  providerValue: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  void providerValue;
  const { axios } = providerContext;
  const query = String(searchQuery || "").trim();
  if (!query) return [];

  try {
    const response = await axios.get(`${WP_API}/anime`, {
      params: {
        search: query,
        per_page: PER_PAGE,
        page: Math.max(1, page || 1),
        orderby: "date",
        order: "desc",
        _embed: "wp:featuredmedia",
      },
      headers: siteHeaders(),
      signal,
    });
    const data = Array.isArray(response.data) ? response.data : [];
    return uniquePosts(data.map(mapAnime));
  } catch (error: any) {
    if (error?.response?.status === 400) return [];
    throw error;
  }
};
