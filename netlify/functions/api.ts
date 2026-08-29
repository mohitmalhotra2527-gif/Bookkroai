/**
 * NETLIFY FUNCTIONS ENTRY (Netlify deployment support).
 *
 * Netlify routes every /api/* request here (see netlify.toml redirects).
 * This is a thin adapter over the EXISTING server routing — same ToolGate,
 * ProviderRouter, safety rules and graceful degradation as the long-running
 * server and the Vercel adapter; nothing is duplicated.
 *
 * Netlify hands us an `event` (not node:req/res), so we shim a minimal
 * IncomingMessage (Readable stream + method/url/headers) and capture the
 * ServerResponse surface the shared router actually uses
 * (writeHead / setHeader / getHeader / end / headersSent).
 *
 * Honest limitation (same as Vercel): serverless instances recycle, so the
 * in-memory conversation store persists only per warm instance.
 */

import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHandleDeps, handleRequest } from '../../api/server.js';

interface NetlifyEvent {
  path: string;
  httpMethod: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
}

export interface NetlifyFunctionResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// Init once per warm instance (keys arrive as server-side env vars on Netlify).
const deps = createHandleDeps();

function buildRequest(event: NetlifyEvent): IncomingMessage {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (value !== undefined) qs.set(key, value);
  }
  const query = qs.toString();
  const req = new Readable({ read() {} }) as Readable & Partial<IncomingMessage>;
  req.method = event.httpMethod || 'GET';
  req.url = event.path + (query ? `?${query}` : '');
  req.headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v ?? '']),
  );
  if (event.body) {
    req.push(event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body));
  }
  req.push(null);
  return req as IncomingMessage;
}

class ResponseCapture {
  statusCode = 200;
  headersSent = false;
  private readonly headers: Record<string, string> = {};
  private readonly chunks: Buffer[] = [];

  writeHead(code: number, hdrs?: Record<string, string | number | string[]>): this {
    this.statusCode = code;
    this.headersSent = true;
    if (hdrs) {
      for (const [key, value] of Object.entries(hdrs)) {
        this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      }
    }
    return this;
  }

  setHeader(key: string, value: string | number | string[]): void {
    this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  getHeader(key: string): string | undefined {
    return this.headers[key.toLowerCase()];
  }

  end(chunk?: string | Buffer): void {
    if (chunk) this.chunks.push(Buffer.from(chunk));
  }

  result(): NetlifyFunctionResponse {
    return {
      statusCode: this.statusCode,
      headers: this.headers,
      body: Buffer.concat(this.chunks).toString('utf8'),
    };
  }
}

export async function handler(event: NetlifyEvent): Promise<NetlifyFunctionResponse> {
  const res = new ResponseCapture();
  try {
    await handleRequest(buildRequest(event), res as unknown as ServerResponse, deps);
  } catch {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    }
    res.end(JSON.stringify({ ok: false, code: 'INTERNAL_ERROR', message: 'Something went wrong.' }));
  }
  return res.result();
}
