import { createRemoteJWKSet, jwtVerify } from 'jose';

// Only public verification keys are cached. Never store identities or requests globally.
const keySets = new Map();
const invalidTokenCodes = new Set([
	'ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWT_INVALID',
	'ERR_JWS_INVALID', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
	'ERR_JOSE_ALG_NOT_ALLOWED', 'ERR_JOSE_NOT_SUPPORTED', 'ERR_JWKS_NO_MATCHING_KEY',
]);

function deny(code, status) {
	return { response: Response.json({ code }, { status, headers: { 'Cache-Control': 'no-store' } }) };
}

function configuration(env) {
	if (typeof env.ACCESS_TEAM_DOMAIN !== 'string'
		|| !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN)
		|| typeof env.ACCESS_AUD !== 'string' || !env.ACCESS_AUD.trim()) return null;
	try {
		const origin = new URL(env.APP_ORIGIN);
		if (origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN) return null;
		return { origin: origin.origin, issuer: `https://${env.ACCESS_TEAM_DOMAIN}`, audience: env.ACCESS_AUD };
	} catch {
		return null;
	}
}

export async function verifyAccess(request, env, serviceClientId = null) {
	const config = configuration(env);
	if (!config) return deny('ACCESS_NOT_CONFIGURED', 503);
	if (new URL(request.url).origin !== config.origin) return deny('ORIGIN_NOT_ALLOWED', 403);
	const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
	if (!assertion || assertion.length > 16384) return deny('ACCESS_REQUIRED', 401);
	try {
		let keys = keySets.get(config.issuer);
		if (!keys) {
			keys = createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
			if (keySets.size >= 4) keySets.delete(keySets.keys().next().value);
			keySets.set(config.issuer, keys);
		}
		const { payload } = await jwtVerify(assertion, keys, {
			issuer: config.issuer, audience: config.audience,
			algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub'],
		});
		if (serviceClientId !== null) {
			if (payload.type !== 'app' || payload.sub !== '' || payload.common_name !== serviceClientId)
				return deny('ACCESS_SERVICE_REQUIRED', 403);
			return { identity: { serviceClientId } };
		}
		if (typeof payload.sub !== 'string' || !payload.sub) return deny('ACCESS_INVALID', 401);
		return { identity: { sub: payload.sub, ...(typeof payload.email === 'string' ? {email:payload.email} : {}) } };
	} catch (error) {
		return invalidTokenCodes.has(error.code)
			? deny('ACCESS_INVALID', 401)
			: deny('ACCESS_UNAVAILABLE', 503);
	}
}
