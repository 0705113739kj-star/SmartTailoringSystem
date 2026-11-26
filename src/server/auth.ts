import type { Request } from 'express';
import type { AuthContext } from '../shared/authCore.ts';

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

export * from '../shared/authCore.ts';
