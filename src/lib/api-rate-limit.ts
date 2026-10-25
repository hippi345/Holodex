export function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener("abort", abort, { once: true })
  })
}

export class ApiRequestBudget {
  private starts: number[] = []
  private remaining = Infinity
  private resetAt = 0
  private retryAt = 0
  private readonly options: {
    limit: number
    windowMs: number
    now: () => number
    sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  }

  constructor(options: {
    limit: number
    windowMs: number
    now: () => number
    sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  }) {
    this.options = options
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    while (true) {
      signal?.throwIfAborted()
      const now = this.options.now()
      this.starts = this.starts.filter(
        (start) => start > now - this.options.windowMs
      )
      if (this.resetAt <= now) this.remaining = Infinity
      const localWait =
        this.starts.length >= this.options.limit
          ? this.starts[0] + this.options.windowMs - now
          : 0
      const serverWait = this.remaining <= 0 ? this.resetAt - now : 0
      const wait = Math.max(localWait, serverWait, this.retryAt - now)
      if (wait > 0) {
        await this.options.sleep(wait, signal)
        continue
      }
      this.starts.push(now)
      this.remaining--
      return
    }
  }

  observe(headers: Headers, status: number): void {
    const reset = Number(headers.get("X-RateLimit-Reset")) * 1000
    const remaining = headers.get("X-RateLimit-Remaining")
    if (
      reset > this.options.now() &&
      remaining !== null &&
      Number.isFinite(Number(remaining))
    ) {
      this.remaining =
        reset === this.resetAt
          ? Math.min(this.remaining, Number(remaining))
          : Number(remaining)
      this.resetAt = reset
    }
    if (status === 429) {
      const seconds = Number(headers.get("Retry-After"))
      this.retryAt = Math.max(
        this.retryAt,
        this.options.now() +
          (seconds > 0 ? seconds * 1000 : this.options.windowMs)
      )
    }
  }
}

export const apiRequestBudget = new ApiRequestBudget({
  limit: 70,
  windowMs: 120_000,
  now: Date.now,
  sleep: abortableDelay,
})
