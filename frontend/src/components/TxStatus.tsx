import { STAGE_LABELS, type TxState } from "../hooks/useTransaction";
import { config } from "../config";
import { Notice, Spinner } from "./ui";

const EXPLORERS: Record<string, string> = {
  testnet: "https://stellar.expert/explorer/testnet/tx",
  public: "https://stellar.expert/explorer/public/tx",
};

/**
 * Renders the current state of a write transaction: in-flight stage, the
 * contract's error message, or a confirmation with an explorer link.
 */
export function TxStatus({ state, onDismiss }: { state: TxState; onDismiss: () => void }) {
  if (state.stage === "idle") return null;

  if (state.stage === "error") {
    return (
      <Notice tone="danger" role="alert">
        <div className="stack" style={{ gap: 8, flex: 1 }}>
          <strong>{state.action ? `${state.action} failed` : "Transaction failed"}</strong>
          <span>{state.error}</span>
          <button className="link-button" onClick={onDismiss} style={{ alignSelf: "flex-start" }}>
            Dismiss
          </button>
        </div>
      </Notice>
    );
  }

  const explorer = EXPLORERS[config.network];
  return (
    <div aria-live="polite" aria-atomic="true">
      {state.stage === "success" ? (
        <Notice tone="accent">
          <div className="stack" style={{ gap: 8, flex: 1 }}>
            <strong>{state.action ? `${state.action} confirmed` : "Confirmed"}</strong>
            {state.hash && explorer ? (
              <a
                href={`${explorer}/${state.hash}`}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 13 }}
              >
                View transaction ↗
              </a>
            ) : null}
            <button className="link-button" onClick={onDismiss} style={{ alignSelf: "flex-start" }}>
              Dismiss
            </button>
          </div>
        </Notice>
      ) : (
        <Notice tone="info">
          <span className="notice-row">
            <Spinner />
            <span>{STAGE_LABELS[state.stage]}</span>
          </span>
        </Notice>
      )}
    </div>
  );
}
