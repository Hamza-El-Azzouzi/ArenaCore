import * as oidc from 'openid-client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHash, randomUUID } from 'node:crypto';

export type TokenScenario = 'valid' | 'wrong_nonce' | 'wrong_issuer' | 'wrong_audience' | 'expired' | 'bad_signature' | 'no_id_token' | 'token_failure';
/** Protocol transport fixture only. It exercises real discovery, PKCE, JWT/JWKS and claim checks. */
export class OidcProviderFixture {
  readonly issuer = 'https://identity.example.test';
  readonly clientId = 'arenacore-integration';
  readonly secret = 'fixture-client-secret';
  readonly subject = `fixture-subject-${randomUUID()}`;
  metadataIssuer = this.issuer;
  endpointProtocol = 'https:';
  tokenRequests = 0;
  failDiscovery = false;
  private codes = new Map<string, {challenge: string; nonce: string; scenario: TokenScenario}>();
  private keys!: Awaited<ReturnType<typeof generateKeyPair>>;
  private rogueKeys!: Awaited<ReturnType<typeof generateKeyPair>>;
  async initialize() { this.keys = await generateKeyPair('RS256'); this.rogueKeys = await generateKeyPair('RS256'); }
  issueCode(authorization: URL, scenario: TokenScenario = 'valid') {
    const code = randomUUID();
    this.codes.set(code, {challenge: authorization.searchParams.get('code_challenge')!, nonce: authorization.searchParams.get('nonce')!, scenario});
    return code;
  }
  fetch: oidc.CustomFetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/.well-known/openid-configuration') {
      if (this.failDiscovery) return Response.json({error: 'unavailable'}, {status: 503});
      const endpoint = (path: string) => `${this.endpointProtocol}//identity.example.test${path}`;
      return Response.json({issuer: this.metadataIssuer, authorization_endpoint: endpoint('/authorize'), token_endpoint: endpoint('/token'), jwks_uri: endpoint('/jwks'), response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], code_challenge_methods_supported: ['S256']});
    }
    if (path === '/jwks') return Response.json({keys: [{...await exportJWK(this.keys.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig'}]});
    if (path === '/token') {
      this.tokenRequests++;
      const params = new URLSearchParams(options.body?.toString());
      const code = params.get('code') ?? '';
      const entry = this.codes.get(code);
      this.codes.delete(code); // Authorization codes are single-use.
      const basic = new Headers(options.headers).get('authorization');
      const basicParts = basic?.startsWith('Basic ') ? Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':').map(value => new URLSearchParams(`value=${value}`).get('value')) : [];
      const secretValid = (basicParts[0] === this.clientId && basicParts[1] === this.secret) || (params.get('client_id') === this.clientId && params.get('client_secret') === this.secret);
      if (!entry || !secretValid || params.get('grant_type') !== 'authorization_code' || !params.get('redirect_uri')?.endsWith('/api/v1/auth/callback') || createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url') !== entry.challenge) {
        return Response.json({error: 'invalid_grant'}, {status: 400});
      }
      if (entry.scenario === 'token_failure') return Response.json({error: 'invalid_grant', error_description: 'PRIVATE_PROVIDER_DIAGNOSTIC'}, {status: 400});
      const now = Math.floor(Date.now()/1000);
      const token = await new SignJWT({nonce: entry.scenario === 'wrong_nonce' ? 'wrong-nonce' : entry.nonce, name: 'Fixture User', email: 'same-email@example.test', roles: ['ADMIN']})
        .setProtectedHeader({alg: 'RS256', kid: 'fixture-key'})
        .setIssuer(entry.scenario === 'wrong_issuer' ? 'https://attacker.example.test' : this.issuer)
        .setSubject(this.subject).setAudience(entry.scenario === 'wrong_audience' ? 'another-client' : this.clientId)
        .setIssuedAt(now - 60).setExpirationTime(entry.scenario === 'expired' ? now - 300 : now + 300)
        .sign(entry.scenario === 'bad_signature' ? this.rogueKeys.privateKey : this.keys.privateKey);
      return Response.json({access_token: 'PRIVATE_ACCESS_TOKEN', token_type: 'Bearer', expires_in: 300, ...(entry.scenario === 'no_id_token' ? {} : {id_token: token})});
    }
    throw new Error('Unexpected identity fixture request');
  };
}
