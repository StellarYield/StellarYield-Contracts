import { EventEmitter } from "node:events";

export interface VaultTvlUpdatePayload {
  contractId: string;
  tvlUsd: string;
  snapshotAt: string;
}

export class TvlPubSub extends EventEmitter {
  publish(update: VaultTvlUpdatePayload): void {
    this.emit("vaultTvlUpdated", update);
    if (update.contractId) {
      this.emit(`vaultTvlUpdated:${update.contractId}`, update);
    }
  }

  asyncIterator(contractId?: string): AsyncIterableIterator<VaultTvlUpdatePayload> {
    const eventName = contractId ? `vaultTvlUpdated:${contractId}` : "vaultTvlUpdated";
    const queue: VaultTvlUpdatePayload[] = [];
    let notify: (() => void) | null = null;
    let listening = true;

    const listener = (payload: VaultTvlUpdatePayload) => {
      queue.push(payload);
      if (notify) {
        notify();
        notify = null;
      }
    };

    const cleanup = () => {
      listening = false;
      this.off(eventName, listener);
      if (notify) {
        notify();
        notify = null;
      }
    };

    this.on(eventName, listener);

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<VaultTvlUpdatePayload, undefined>> {
        while (listening) {
          if (queue.length > 0) {
            return { value: queue.shift()!, done: false };
          }
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
        return { value: undefined, done: true };
      },
      async return(): Promise<IteratorResult<VaultTvlUpdatePayload, undefined>> {
        cleanup();
        return { value: undefined, done: true };
      },
      async throw(err?: any): Promise<IteratorResult<VaultTvlUpdatePayload>> {
        cleanup();
        throw err;
      },
    };
  }
}

export const tvlPubSub = new TvlPubSub();
