/**
 * Restarting the server in the same process, such as to finish a restore:
 * the host that runs it stops everything, then starts it again. Asking
 * waits a second first, so the request that asked gets its answer.
 *
 * @module
 */
import { Context, type Effect } from "effect";

export class Restart extends Context.Service<
  Restart,
  {
    /** Restarts the server shortly; it returns at once. */
    readonly request: Effect.Effect<void>;
  }
>()("@timmo001/kestrel-server/Restart") {}
