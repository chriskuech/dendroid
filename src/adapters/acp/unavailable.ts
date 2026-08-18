import { AgentUnavailableError, type AcpAdapter } from "./types";

/** Nothing able to spawn a subprocess outside Tauri. */
export function createUnavailableAcp(): AcpAdapter {
  return {
    startAgent: async () => {
      throw new AgentUnavailableError();
    },
    stopAgent: async () => {},
    sendPrompt: async () => {
      throw new AgentUnavailableError();
    },
    cancelPrompt: async () => {},
    respondPermission: async () => {},
    onAgentEvent: () => () => {},
  };
}
