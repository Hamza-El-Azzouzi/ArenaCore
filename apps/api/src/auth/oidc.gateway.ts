import { Inject, Injectable } from '@nestjs/common';
import * as oidc from 'openid-client';
import { Config } from '../config/config';
import { ApiError } from '../common/errors';

export interface VerifiedIdentity { issuer: string; subject: string; displayName: string }
export interface LoginProof { verifier: string; nonce: string }

@Injectable()
export class OidcGateway {
  private configuration?: Promise<oidc.Configuration>;
  constructor(@Inject(Config) private readonly config: Config) {}
  protected discoveryOptions(): oidc.DiscoveryRequestOptions {
    return {timeout: 10, execute: [oidc.enableNonRepudiationChecks]};
  }
  private async discover() {
    if (!this.config.oidcEnabled) throw new ApiError(503, 'IDENTITY_NOT_CONFIGURED', 'Sign-in is not available yet.');
    if (!this.configuration) {
      this.configuration = this.load().catch(() => {
        this.configuration = undefined; // Allow recovery after a provider outage.
        throw new ApiError(503, 'IDENTITY_UNAVAILABLE', 'The sign-in provider is temporarily unavailable.');
      });
    }
    return this.configuration;
  }
  private async load() {
    const v = this.config.values;
    const configuration = await oidc.discovery(new URL(v.OIDC_ISSUER!), v.OIDC_CLIENT_ID!, {
      client_secret: v.OIDC_CLIENT_SECRET!, id_token_signed_response_alg: v.OIDC_ID_TOKEN_ALG,
    }, v.OIDC_CLIENT_AUTH_METHOD === 'client_secret_basic' ? oidc.ClientSecretBasic(v.OIDC_CLIENT_SECRET!) : oidc.ClientSecretPost(v.OIDC_CLIENT_SECRET!), this.discoveryOptions());
    const metadata = configuration.serverMetadata();
    for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) {
      if (!endpoint) throw new Error('Missing OIDC endpoint');
      const url = new URL(endpoint);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Unsafe OIDC endpoint');
    }
    if (!metadata.id_token_signing_alg_values_supported?.includes(v.OIDC_ID_TOKEN_ALG)) throw new Error('Configured signed ID-token algorithm is unsupported');
    if (metadata.token_endpoint_auth_methods_supported && !metadata.token_endpoint_auth_methods_supported.includes(v.OIDC_CLIENT_AUTH_METHOD)) throw new Error('Configured client authentication method is unsupported');
    if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes('S256')) throw new Error('PKCE S256 is required');
    return configuration;
  }
  async authorizationUrl(state: string, proof: LoginProof) {
    const configuration = await this.discover();
    return oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.config.callbackUrl, scope: 'openid profile', response_type: 'code', response_mode: 'query',
      state, nonce: proof.nonce, code_challenge: await oidc.calculatePKCECodeChallenge(proof.verifier), code_challenge_method: 'S256',
    });
  }
  async exchange(callbackUrl: URL, state: string, proof: LoginProof): Promise<VerifiedIdentity> {
    const configuration = await this.discover();
    try {
      const tokens = await oidc.authorizationCodeGrant(configuration, callbackUrl, {
        pkceCodeVerifier: proof.verifier, expectedState: state, expectedNonce: proof.nonce, idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || claims.iss !== this.config.values.OIDC_ISSUER) throw new Error('Invalid identity');
      const name = typeof claims.name === 'string' ? claims.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : '';
      return {issuer: claims.iss, subject: claims.sub, displayName: name || 'ArenaCore user'};
      // Provider access/refresh/ID tokens are intentionally not persisted or returned.
    } catch {
      throw new ApiError(401, 'LOGIN_FAILED', 'Sign-in could not be verified. Please start again.');
    }
  }
}
