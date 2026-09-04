export interface ModelOption { model: string; label: string; apiFamily: string; description?: string }
export interface ApiTestResult { ok: boolean; status: number; elapsedMs: number; requestId: string | null; body: unknown }
export interface UserApiTestValues { model: string; requestParams: string }
export interface UserApiTestCommand { payload: Record<string, unknown>; signal: AbortSignal }
export interface UserApiTestExecution { result: ApiTestResult | null; rawResponse: string; errorMessage: string | null }
