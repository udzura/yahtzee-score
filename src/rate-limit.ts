type LimitBindings = Pick<Env, 'API_RATE_LIMITER' | 'CREATE_RATE_LIMITER' | 'WRITE_RATE_LIMITER' | 'LIVE_RATE_LIMITER'>;

// Apply before any Durable Object lookup, including requests for unknown rooms.
export async function limitApiRequest(request: Request, env: LimitBindings): Promise<Response | undefined> {
	const path = new URL(request.url).pathname;
	// CF supplies this header at the public edge. Do not trust X-Forwarded-For or cookies.
	// Local requests without the header share a bucket rather than bypassing protection.
	const key = `yahtzee-score:ip:${request.headers.get('CF-Connecting-IP') || 'unknown'}`;
	const limits = [env.API_RATE_LIMITER];
	if (path === '/api/rooms' && request.method === 'POST') limits.push(env.CREATE_RATE_LIMITER);
	else if (request.method === 'GET' && path.endsWith('/live')) limits.push(env.LIVE_RATE_LIMITER);
	else if (request.method !== 'GET' && request.method !== 'HEAD') limits.push(env.WRITE_RATE_LIMITER);
	try {
		for (const limiter of limits) {
			if (!(await limiter.limit({ key })).success) {
				return Response.json(
					{ error: '操作が多すぎます。1分ほど待ってから、もう一度お試しください。' },
					{ status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } },
				);
			}
		}
	} catch {
		// An unavailable limiter must not silently allow unlimited room creation.
		console.error('API rate limiter unavailable');
		return Response.json(
			{ error: 'ただいま接続を確認できません。少し待ってから、もう一度お試しください。' },
			{ status: 503, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } },
		);
	}
}
