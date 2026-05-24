import { describe, expect, it } from "vitest";
import { transferDataFromEvent } from "./getVibRelayDepositWatcher.js";

describe("getVibRelayDepositWatcher helpers", () => {
  it("normalizes object-shaped Balances.Transfer event data", () => {
    expect(transferDataFromEvent({
      toJSON: () => ({
        from: "alice",
        to: "deposit",
        amount: "10000000000",
      }),
    })).toEqual({
      from: "alice",
      to: "deposit",
      amountBaseUnits: "10000000000",
    });
  });

  it("normalizes tuple-shaped Balances.Transfer event data", () => {
    expect(transferDataFromEvent({
      toJSON: () => ["alice", "deposit", "12500000000"],
    })).toEqual({
      from: "alice",
      to: "deposit",
      amountBaseUnits: "12500000000",
    });
  });
});
