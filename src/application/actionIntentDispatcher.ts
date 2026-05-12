/**
 * ActionIntentDispatcher — routes an ActionIntent to the appropriate
 * ApplicationService handler.
 *
 * Handlers are registered at startup; the dispatcher is stateless at
 * request time.  Each handler receives the intent plus the Fastify
 * request context (store, eventBus, config, etc.) via a shared
 * `DispatchContext`.
 */

import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import type { EventBus } from "../services/eventBus.js";
import type { CoordinatorConfig } from "../config/env.js";
import type { Concord } from "@concord/sdk";
import type { ActionIntent, ActionIntentResult, ActionIntentType } from "./types.js";
import { badRequest } from "../domain/errors.js";

export interface DispatchContext {
  store: CoordinatorStorePort;
  eventBus: EventBus;
  config: CoordinatorConfig;
  concord: Concord;
  /** The resolved principal id from auth middleware. */
  principalId: string;
}

export type IntentHandler = (
  intent: ActionIntent,
  ctx: DispatchContext,
) => Promise<ActionIntentResult>;

export class ActionIntentDispatcher {
  private readonly handlers = new Map<ActionIntentType, IntentHandler>();

  register(type: ActionIntentType, handler: IntentHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  async dispatch(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
    const handler = this.handlers.get(intent.type);
    if (!handler) {
      throw badRequest(
        `Unsupported ActionIntent type: ${intent.type}`,
        { knownTypes: [...this.handlers.keys()] },
      );
    }
    return handler(intent, ctx);
  }
}
