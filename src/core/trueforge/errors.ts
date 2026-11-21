export type FailureKind = "auth" | "unreachable" | "rate_limit" | "server" | "bad_request" | "model_not_found" | "timeout" | "unknown";

export interface Failure {
  kind: FailureKind;
  /** Worth retrying the same model (transient). */
  retryable: boolean;
  /** Plain-language message for the user. */
  message: string;
  raw: string;
}

/**
 * Classify a model failure reported by TrueForge (turn.done state=error) or a
 * transport error. Permanent failures (bad key, unknown model) are never
 * retried on the same model; transient ones are retried with backoff.
 */
export function classifyFailure(raw: string): Failure {
  const r = raw || "unknown error";
  const status = Number((r.match(/\((\d{3})\)|\b(4\d\d|5\d\d)\b/) || [])[1] || (r.match(/\b(4\d\d|5\d\d)\b/) || [])[1] || 0);
  const has = (re: RegExp) => re.test(r);
  if (status === 401 || status === 403 || has(/invalid[_ ]?api[_ ]?key|unauthori[sz]ed|incorrect api key|authentication|permission denied|forbidden/i)) {
    return { kind: "auth", retryable: false, message: "The model provider rejected the credentials (invalid or missing API key).", raw: r };
  }
  if (status === 404 || has(/model[^.]{0,40}(not found|does not exist|unknown)|no such model/i)) {
    return { kind: "model_not_found", retryable: false, message: "The configured model does not exist at this provider.", raw: r };
  }
  if (status === 429 || has(/rate.?limit|too many requests|quota/i)) {
    return { kind: "rate_limit", retryable: true, message: "The model provider is rate-limiting requests.", raw: r };
  }
  if (has(/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|fetch failed|socket hang up|connect|network|unreachable|getaddrinfo/i)) {
    return { kind: "unreachable", retryable: true, message: "The model endpoint could not be reached.", raw: r };
  }
  if (has(/timed? ?out|ETIMEDOUT|deadline/i)) {
    return { kind: "timeout", retryable: true, message: "The model request timed out.", raw: r };
  }
  if (status >= 500) {
    return { kind: "server", retryable: true, message: `The model provider returned a server error (${status}).`, raw: r };
  }
  if (status >= 400) {
    return { kind: "bad_request", retryable: false, message: `The model provider rejected the request (${status}).`, raw: r };
  }
  return { kind: "unknown", retryable: true, message: "The model call failed.", raw: r };
}

export function backoffMs(attempt: number, baseMs: number): number {
  // attempt 1 -> base, 2 -> 2x base, ... with +/-20% jitter, capped at 8 s
  const exp = Math.min(baseMs * 2 ** (attempt - 1), 8000);
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}
