import { Inject, Injectable } from '@nestjs/common';
import * as oidc from 'openid-client';
import { Config } from '../config/config';
import { ApiError } from '../common/errors';

export interface VerifiedIdentity { issuer: string; subject: string; displayName: string }
export type SocialProvider = 'auth0' | 'google' | 'github';
export interface LoginProof { provider: SocialProvider; verifier: string; nonce: string }

@Injectable()
export class OidcGateway {
  private readonly configurations = new Map<'auth0'|'google', Promise<oidc.Configuration>>();
  constructor(@Inject(Config) private readonly config: Config) {}
  protected discoveryOptions(): oidc.DiscoveryRequestOptions {
    return {timeout: 10, execute: [oidc.enableNonRepudiationChecks]};
  }
  private settings(provider: 'auth0'|'google') {
    const v = this.config.values;
    if (provider === 'google') {
      if (v.GOOGLE_AUTH_ENABLED !== 'true') throw new ApiError(503, 'IDENTITY_NOT_CONFIGURED', 'Google sign-in is not available yet.');
      return {issuer: 'https://accounts.google.com', clientId: v.GOOGLE_CLIENT_ID!, clientSecret: v.GOOGLE_CLIENT_SECRET!, method: 'client_secret_post' as const, algorithm: 'RS256' as const};
    }
    if (!this.config.oidcEnabled) throw new ApiError(503, 'IDENTITY_NOT_CONFIGURED', 'Sign-in is not available yet.');
    return {issuer: v.OIDC_ISSUER!, clientId: v.OIDC_CLIENT_ID!, clientSecret: v.OIDC_CLIENT_SECRET!, method: v.OIDC_CLIENT_AUTH_METHOD, algorithm: v.OIDC_ID_TOKEN_ALG};
  }
  private async discover(provider: 'auth0'|'google') {
    this.settings(provider);
    if (!this.configurations.has(provider)) {
      const pending = this.load(provider).catch(() => {
        this.configurations.delete(provider); // Allow recovery after a provider outage.
        throw new ApiError(503, 'IDENTITY_UNAVAILABLE', 'The sign-in provider is temporarily unavailable.');
      });
      this.configurations.set(provider, pending);
    }
    return this.configurations.get(provider)!;
  }
  private async load(provider: 'auth0'|'google') {
    const settings = this.settings(provider);
    const configuration = await oidc.discovery(new URL(settings.issuer), settings.clientId, {
      client_secret: settings.clientSecret, id_token_signed_response_alg: settings.algorithm,
    }, settings.method === 'client_secret_basic' ? oidc.ClientSecretBasic(settings.clientSecret) : oidc.ClientSecretPost(settings.clientSecret), this.discoveryOptions());
    const metadata = configuration.serverMetadata();
    for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) {
      if (!endpoint) throw new Error('Missing OIDC endpoint');
      const url = new URL(endpoint);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Unsafe OIDC endpoint');
    }
    if (!metadata.id_token_signing_alg_values_supported?.includes(settings.algorithm)) throw new Error('Configured signed ID-token algorithm is unsupported');
    if (metadata.token_endpoint_auth_methods_supported && !metadata.token_endpoint_auth_methods_supported.includes(settings.method)) throw new Error('Configured client authentication method is unsupported');
    if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes('S256')) throw new Error('PKCE S256 is required');
    return configuration;
  }
  async authorizationUrl(state: string, proof: LoginProof) {
    if (proof.provider === 'github') throw new Error('GitHub is not an OIDC provider');
    const configuration = await this.discover(proof.provider);
    return oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.config.callbackUrl, scope: 'openid profile', response_type: 'code', response_mode: 'query',
      state, nonce: proof.nonce, code_challenge: await oidc.calculatePKCECodeChallenge(proof.verifier), code_challenge_method: 'S256',
    });
  }
  async exchange(callbackUrl: URL, state: string, proof: LoginProof): Promise<VerifiedIdentity> {
    if (proof.provider === 'github') throw new Error('GitHub is not an OIDC provider');
    const configuration = await this.discover(proof.provider);
    try {
      const tokens = await oidc.authorizationCodeGrant(configuration, callbackUrl, {
        pkceCodeVerifier: proof.verifier, expectedState: state, expectedNonce: proof.nonce, idTokenExpected: true,
      });
      const claims = tokens.claims();
      const expectedIssuer = this.settings(proof.provider).issuer;
      if (!claims || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || claims.iss !== expectedIssuer) throw new Error('Invalid identity');
      const name = typeof claims.name === 'string' ? claims.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : '';
      return {issuer: claims.iss, subject: claims.sub, displayName: name || 'ArenaCore user'};
      // Provider access/refresh/ID tokens are intentionally not persisted or returned.
    } catch {
      throw new ApiError(401, 'LOGIN_FAILED', 'Sign-in could not be verified. Please start again.');
    }
  }
}
