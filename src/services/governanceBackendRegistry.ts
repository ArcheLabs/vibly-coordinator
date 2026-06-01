/**
 * GovernanceBackendRegistry
 *
 * Manages multiple governance backend consumers (Substrate, EVM, etc.).
 * Each registered backend gets its own GovernanceIndexConsumer instance.
 *
 * Design:
 * - `register(descriptor, consumer)` — add a backend + its consumer
 * - `listDescriptors()` — enumerate registered backends (for API)
 * - `startAll()` — start all registered consumers
 */

import type { GovernanceBackendDescriptor } from "@vibly-ai/concord-governance";
import type { GovernanceIndexConsumer } from "./governanceIndexConsumer.js";

export interface RegisteredBackend {
  descriptor: GovernanceBackendDescriptor;
  consumer: GovernanceIndexConsumer;
}

export class GovernanceBackendRegistry {
  private readonly backends: RegisteredBackend[] = [];

  register(descriptor: GovernanceBackendDescriptor, consumer: GovernanceIndexConsumer): void {
    this.backends.push({ descriptor, consumer });
  }

  listDescriptors(): GovernanceBackendDescriptor[] {
    return this.backends.map((b) => b.descriptor);
  }

  startAll(): void {
    for (const { consumer, descriptor } of this.backends) {
      consumer.start();
      // eslint-disable-next-line no-console
      console.info(
        `[GovernanceBackendRegistry] started consumer for backend "${descriptor.id}" (${descriptor.backend})`,
      );
    }
  }

  stopAll(): void {
    for (const { consumer, descriptor } of this.backends) {
      consumer.stop();
      // eslint-disable-next-line no-console
      console.info(
        `[GovernanceBackendRegistry] stopped consumer for backend "${descriptor.id}" (${descriptor.backend})`,
      );
    }
  }

  get size(): number {
    return this.backends.length;
  }
}
