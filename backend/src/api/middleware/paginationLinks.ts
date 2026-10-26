import type { Request, Response } from "express";

/**
 * RFC 8288 Web Linking for cursor-paginated responses (#1179).
 *
 * Generates `Link` headers with `rel="next"` and `rel="prev"` for cursor-based
 * pagination, preserving all existing query parameters in the generated URLs.
 *
 * @param res - Express response object
 * @param req - Express request object
 * @param cursors - Optional next and previous cursor values
 */
export function setPaginationLinks(
  res: Response,
  req: Request,
  cursors: { nextCursor?: string | null; prevCursor?: string | null },
): void {
  const links: string[] = [];

  const baseUrl = req.protocol + "://" + req.get("host") + req.path;
  const url = new URL(baseUrl, "http://dummy");

  const queryParams = new URLSearchParams(req.query as Record<string, string>);
  queryParams.delete("cursor");

  if (cursors.nextCursor) {
    const nextUrl = new URL(url);
    nextUrl.search = queryParams.toString();
    nextUrl.searchParams.set("cursor", cursors.nextCursor);
    links.push(`<${nextUrl.pathname}${nextUrl.search}>; rel="next"`);
  }

  if (cursors.prevCursor) {
    const prevUrl = new URL(url);
    prevUrl.search = queryParams.toString();
    prevUrl.searchParams.set("cursor", cursors.prevCursor);
    links.push(`<${prevUrl.pathname}${prevUrl.search}>; rel="prev"`);
  }

  if (links.length > 0) {
    res.set("Link", links.join(", "));
  }
}
