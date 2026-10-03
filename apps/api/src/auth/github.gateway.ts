import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import { Config } from '../config/config';
import { LoginProof, VerifiedIdentity } from './oidc.gateway';

const tokenResponse = z.object({access_token: z.string().min(1).max(2048), token_type: z.string().toLowerCase().pipe(z.literal('bearer'))}).passthrough();
const userResponse = z.object({id: z.number().int().positive(), login: z.string().min(1).max(100), name: z.string().max(120).nullable().optional()}).passthrough();

@Injectable()
export class GithubGateway {
  constructor(@Inject(Config) private readonly config: Config) {}
  private settings() {
    const v = this.config.values;
    if (v.GITHUB_AUTH_ENABLED !== 'true') throw new ApiError(503, 'IDENTITY_NOT_CONFIGURED', 'GitHub sign-in is not available yet.');
    return {clientId: v.GITHUB_CLIENT_ID!, clientSecret: v.GITHUB_CLIENT_SECRET!};
  }
  authorizationUrl(state: string, proof: LoginProof) {
    const {clientId} = this.settings();
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({client_id: clientId, redirect_uri: this.config.callbackUrl, state, code_challenge: createHash('sha256').update(proof.verifier).digest('base64url'), code_challenge_method: 'S256', allow_signup: 'true'}).toString();
    return url;
  }
  async exchange(callbackUrl: URL, state: string, proof: LoginProof): Promise<VerifiedIdentity> {
    const {clientId, clientSecret} = this.settings();
    if (callbackUrl.searchParams.get('state') !== state || !callbackUrl.searchParams.get('code')) throw new ApiError(401, 'LOGIN_FAILED', 'Sign-in could not be verified. Please start again.');
    try {
      const tokenRequest = await fetch('https://github.com/login/oauth/access_token', {method: 'POST', signal: AbortSignal.timeout(10_000), headers: {'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({client_id: clientId, client_secret: clientSecret, code: callbackUrl.searchParams.get('code')!, redirect_uri: this.config.callbackUrl, code_verifier: proof.verifier})});
      if (!tokenRequest.ok) throw new Error('Token request failed');
      const token = tokenResponse.parse(await tokenRequest.json());
      const profileRequest = await fetch('https://api.github.com/user', {signal: AbortSignal.timeout(10_000), headers: {'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token.access_token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ArenaCore'}});
      if (!profileRequest.ok) throw new Error('Profile request failed');
      const profile = userResponse.parse(await profileRequest.json());
      const name = (profile.name || profile.login).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
      return {issuer: 'https://github.com', subject: String(profile.id), displayName: name || 'ArenaCore user'};
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(401, 'LOGIN_FAILED', 'Sign-in could not be verified. Please start again.');
    }
  }
}
