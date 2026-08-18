import { AutomationsUnavailableError, type AutomationsEngineAdapter } from "./types";

/** Nothing able to run a background engine outside Tauri. */
export function createUnavailableAutomationsEngine(): AutomationsEngineAdapter {
  return {
    setAutomationsCwd() {},
    async syncAutomationsEngine() {},
    runAutomationNow: async () => {
      throw new AutomationsUnavailableError();
    },
    listAutomationRuns: async () => [],
    getAutomationRun: async () => {
      throw new AutomationsUnavailableError();
    },
    onAutomationRun: () => () => {},
  };
}
