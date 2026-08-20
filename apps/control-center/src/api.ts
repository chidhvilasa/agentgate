/**
 * Gateway API client — connects to the local AgentGate control API.
 *
 * Auth token is read from the VITE_AGENTGATE_TOKEN env variable
 * (injected at launch time) or from localStorage as a fallback for dev.
 */

const BASE_URL = import.meta.env.VITE_CONTROL_URL ?? 'http://127.0.0.1:4001';
const TOKEN = import.meta.env.VITE_AGENTGATE_TOKEN ?? localStorage.getItem('agentgate_token') ?? '';

function headers(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'x-agentgate-token': TOKEN,
  };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return res.json();
}

export const api = {
  health: () => get<{ status: string; uptime_seconds: number; active_agents: number }>('/api/health'),
  events: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return get<unknown[]>(`/api/events${qs}`);
  },
  event: (id: string) => get<unknown>(`/api/events/${id}`),
  approvals: () => get<unknown[]>('/api/approvals'),
  approve: (id: string, eventId: string) => post(`/api/approvals/${id}/approve`, { event_id: eventId }),
  deny: (id: string) => post(`/api/approvals/${id}/deny`),
};

/** Opens an SSE connection to the event stream. */
export function openEventStream(
  onEvent: (data: unknown) => void,
  onError?: () => void
): EventSource {
  const url = `${BASE_URL}/api/events/stream?token=${encodeURIComponent(TOKEN)}`;
  const es = new EventSource(url);
  es.addEventListener('audit_event', (e) => {
    try { onEvent(JSON.parse(e.data)); } catch {}
  });
  es.onerror = () => onError?.();
  return es;
}
