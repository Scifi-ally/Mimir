import Parser from "rss-parser";
import { logger } from "../lib/logger";

const parser = new Parser();

export async function fetchRecentNews(symbol: string): Promise<string[]> {
  try {
    // We use Google News RSS for the specific stock symbol
    const query = encodeURIComponent(`"${symbol}" stock NSE`);
    const feed = await parser.parseURL(`https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en`);
    
    // Grab the top 3 headlines
    const headlines = feed.items.slice(0, 3).map(item => item.title || "");
    return headlines.filter(h => h.length > 0);
  } catch (error) {
    logger.error({ symbol, error: String(error) }, "Failed to fetch RSS news");
    return [];
  }
}
