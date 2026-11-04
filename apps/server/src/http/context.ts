import type { Response } from 'express';
import type { Auth, Session } from '../module/auth/index.js';
import type { Dialogue } from '../workflow/dialogue/index.js';
import type { Services } from '../workflow/services.js';

export type Workspace = Services & { dialogue: Dialogue };
export type HttpDependencies = {
  auth: Auth;
  forUser: (userId: string) => Workspace;
};
export type AccountContext = { session: Session; workspace: Workspace };

// The account middleware populates this before mounting any private router.
export function accountContext(res: Response): AccountContext {
  return res.locals.account;
}
