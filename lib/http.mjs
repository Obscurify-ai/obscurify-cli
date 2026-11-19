// Requests to Obscurify. Errors carry the server's message and status.
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function client(api, { headers = {} } = {}) {
  return async function call(method, path, body, extra = {}) {
    let res;
    try {
      res = await fetch(api + path, {
        method,
        headers: {
          'User-Agent': 'obscurify-cli',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
          ...extra,
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
    } catch (e) {
      throw new ApiError(`Couldn't reach ${api}: ${e.cause?.message || e.message}`, 0);
    }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
    if (!res.ok) {
      const wait = res.headers.get('retry-after');
      throw new ApiError((data.error || data.message || `${path} answered ${res.status}`) + (wait ? ` (try again in ${wait} s)` : ''), res.status);
    }
    data._headers = res.headers;
    return data;
  };
}
