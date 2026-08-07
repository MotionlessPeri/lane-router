export class BrokerClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class BrokerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}
  health(): Promise<{ status: string }> {
    return this.get("/v1/health");
  }
  status(): Promise<unknown> {
    return this.get("/v1/status");
  }
  events(after = 0): Promise<unknown[]> {
    return this.get(`/v1/events?after=${after}`);
  }
  call<T = unknown>(method: string, params: unknown): Promise<T> {
    return this.request("/v1/rpc", {
      method: "POST",
      body: JSON.stringify({ method, params }),
    });
  }
  private get<T>(path: string): Promise<T> {
    return this.request(path, { method: "GET" });
  }
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    const envelope = (await response.json()) as
      | { ok: true; data: T }
      | {
          ok: false;
          error: { code: string; message: string; details?: unknown };
        };
    if (!envelope.ok)
      throw new BrokerClientError(
        envelope.error.code,
        envelope.error.message,
        envelope.error.details,
      );
    return envelope.data;
  }
}
