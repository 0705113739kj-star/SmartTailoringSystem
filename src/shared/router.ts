export interface AuthContext {
  userId: number;
  businessId: number;
  fullName: string;
  username: string;
  email: string;
  phone: string;
  businessName: string;
  businessAddress: string;
  receiptFooter: string;
  currency: string;
  csrfToken: string;
}

export interface AppRequest {
  method: string;
  path?: string;
  params: Record<string, string>;
  query: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string>;
  body: any;
  secure?: boolean;
  auth?: AuthContext;
}

export interface AppResponse {
  status(code: number): AppResponse;
  json(body: unknown): unknown;
  send(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
  cookie(name: string, value: string, options?: Record<string, unknown>): unknown;
  clearCookie(name: string, options?: Record<string, unknown>): unknown;
}

export type AppNext = (err?: unknown) => void | Promise<void>;
export type AppHandler = (req: AppRequest, res: AppResponse, next?: AppNext) => unknown | Promise<unknown>;

export interface AppRouter {
  use(handler: AppHandler): unknown;
  get(path: string, ...handlers: AppHandler[]): unknown;
  post(path: string, ...handlers: AppHandler[]): unknown;
  put(path: string, ...handlers: AppHandler[]): unknown;
  patch(path: string, ...handlers: AppHandler[]): unknown;
  delete(path: string, ...handlers: AppHandler[]): unknown;
}
