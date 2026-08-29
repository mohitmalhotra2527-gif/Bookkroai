/**
 * Exercises the Netlify Functions adapter end-to-end (event shim → shared
 * router). Proves the serverless path executes the same routing/safety code
 * as the long-running server, without needing Netlify connectivity.
 */
import { describe, expect, it } from 'vitest';
import { handler } from '../netlify/functions/api.js';

describe('netlify functions adapter', () => {
  it('serves /api/health through the event shim', async () => {
    const res = await handler({ path: '/api/health', httpMethod: 'GET' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.aiFallback).toBe('deterministic-nlu');
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('runs /api/chat through the shared orchestrator', async () => {
    const res = await handler({
      path: '/api/chat',
      httpMethod: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '12014 ka live status batao' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.intent).toBe('LIVE_TRAIN_STATUS');
  });

  it('rejects invalid chat bodies with 400', async () => {
    const res = await handler({
      path: '/api/chat',
      httpMethod: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).ok).toBe(false);
  });

  it('answers CORS preflight', async () => {
    const res = await handler({ path: '/api/chat', httpMethod: 'OPTIONS' });
    expect(res.statusCode).toBeLessThan(300);
  });

  it('404s unknown api paths', async () => {
    const res = await handler({ path: '/api/nope', httpMethod: 'GET' });
    expect(res.statusCode).toBe(404);
  });
});
