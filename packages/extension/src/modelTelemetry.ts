/**
 * The local Copilot telemetry receiver now lives in `@slipstream/core` so both
 * the VS Code extension and the CLI daemon can host it. This module re-exports
 * it to keep the extension's existing import paths stable.
 */
export {
  parseModelTelemetry,
  recordModelObservation,
  startModelTelemetryReceiver,
  managedTelemetryEnv,
  type ModelObservation,
  type ModelTelemetryReceiver,
} from '@slipstream/core';
