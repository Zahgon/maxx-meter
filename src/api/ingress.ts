import type { Request } from "express";

const INGRESS_PATH_HEADER = "x-ingress-path";

// Supervisor proxies the dashboard under /api/hassio_ingress/<session>, strips that
// prefix before forwarding, and passes the public prefix in X-Ingress-Path. The browser
// still resolves URLs against the prefixed path, so anything root-absolute hits Home
// Assistant itself and 404s.
const SAFE_PATH = /^\/[A-Za-z0-9._~\-/]*$/;

export function ingressBasePath(req: Request): string {
  const raw = req.headers[INGRESS_PATH_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value) return "";
  const trimmed = value.replace(/\/+$/, "");
  if (!trimmed || !SAFE_PATH.test(trimmed)) return "";
  return trimmed;
}

export function withIngressBase(html: string, basePath: string): string {
  const tag = `<base href="${basePath}/" />`;
  const withoutBase = html.replace(/\s*<base\b[^>]*>/gi, "");
  if (/<head\b[^>]*>/i.test(withoutBase)) {
    return withoutBase.replace(/<head\b[^>]*>/i, (head) => `${head}\n    ${tag}`);
  }
  return `${tag}${withoutBase}`;
}
