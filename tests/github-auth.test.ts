import {afterEach, describe, expect, it, vi} from 'vitest';
import {Config} from '../apps/api/src/config/config';
import {GithubGateway} from '../apps/api/src/auth/github.gateway';

const config = {values: {GITHUB_AUTH_ENABLED: 'true', GITHUB_CLIENT_ID: 'client-id', GITHUB_CLIENT_SECRET: 'client-secret'}, callbackUrl: 'https://api.example.test/api/v1/auth/callback'} as Config;
const proof = {provider: 'github' as const, verifier: 'v'.repeat(43), nonce: 'n'.repeat(43)};

afterEach(() => vi.unstubAllGlobals());

describe('GitHub OAuth gateway', () => {
  it('uses state, the exact callback, and PKCE without requesting account scopes', () => {
    const url = new GithubGateway(config).authorizationUrl('s'.repeat(43), proof);
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('state')).toBe('s'.repeat(43));
    expect(url.searchParams.get('redirect_uri')).toBe(config.callbackUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.toString()).not.toContain('client-secret');
  });

  it('exchanges the code, revalidates the stable user ID, and does not return the token', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({access_token: 'private-provider-token', token_type: 'bearer'}), {status: 200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({id: 12345, login: 'octocat', name: 'Octo Cat'}), {status: 200}));
    vi.stubGlobal('fetch', fetch);
    const callback = new URL(`${config.callbackUrl}?state=${'s'.repeat(43)}&code=temporary-code`);

    const identity = await new GithubGateway(config).exchange(callback, 's'.repeat(43), proof);

    expect(identity).toEqual({issuer: 'https://github.com', subject: '12345', displayName: 'Octo Cat'});
    expect(JSON.stringify(identity)).not.toContain('private-provider-token');
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.github.com/user', expect.objectContaining({headers: expect.objectContaining({Authorization: 'Bearer private-provider-token'})}));
  });
});
