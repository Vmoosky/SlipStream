/**
 * The local Copilot telemetry receiver now lives in `@slipstream/core` so both
 * the VS Code extension and the CLI daemon can host it. This module re-exports
 * it to keep the extension's existing import paths stable.
 */
export {
  parseModelTelemetry,
  parseToolTelemetry,
  recordModelObservation,
  recordToolObservation,
  startModelTelemetryReceiver,
  managedTelemetryEnv,
  type ModelObservation,
  type ToolObservation,
  type ModelTelemetryReceiver,
} from '@slipstream/core';
