/**
 * Agent op executor — public surface for the chat panel.
 *
 * Typical use from a React chat panel:
 *
 *   import {
 *     requestPlan, AgentRequestError,
 *     executePlan, buildExecutorHelpers,
 *   } from "../agent";
 *
 *   const { plan } = await requestPlan({ goal, context });
 *   if (plan.steps.length === 0) showMessage(plan.message);   // clarification
 *   const helpers = buildExecutorHelpers({ onJobProgress: setBar });
 *   const result = await executePlan(plan, helpers, onStepProgress);
 */

// Planner endpoint client.
export { requestPlan, AgentRequestError } from "./agentClient";

// The executor (pure async, dependency-injected).
export {
  executeStep,
  executePlan,
  parseHexColor,
  OP_HANDLERS,
  JOB_OPS,
  SUPPORTED_OPS,
} from "./executor";
export type {
  ExecutorEngine,
  ExecutorHelpers,
  RunJob,
  PresignUpload,
  IdempotencyKey,
  PlaceArtifact,
  Geometry,
  StepResult,
  PlanResult,
  ProgressEvent,
  OnProgress,
} from "./executor";

// Composition root: build the real helpers from the app singletons.
export { buildExecutorHelpers } from "./helpers";
export type { JobProgressHandlers } from "./helpers";

// Re-export the wire types the panel renders, so it can import everything agent
// from one place.
export type {
  AgentPlan,
  AgentStep,
  AgentContext,
  AgentRequest,
  AgentResponse,
} from "@aips/shared-types";
