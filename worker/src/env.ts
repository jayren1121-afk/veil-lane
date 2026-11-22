import type { Accounts } from './Accounts';
import type { MatchRoom } from './MatchRoom';

export interface Env {
  MATCH_ROOM: DurableObjectNamespace<MatchRoom>;
  ACCOUNTS: DurableObjectNamespace<Accounts>;
  /** OAuth Web client ID from Google Cloud Console. Empty = Google sign-in disabled. */
  GOOGLE_CLIENT_ID: string;
  /** Optional comma-separated extra allowed origins (e.g. a custom domain). */
  ALLOWED_ORIGINS?: string;
}
