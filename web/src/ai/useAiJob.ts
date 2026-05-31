/**
 * useAiJob — shared submit → WebSocket-progress → artifact hook.
 *
 * Every job-based AI action (generate, inpaint, outpaint, upscale, server-side
 * remove-bg) follows the same lifecycle:
 *   POST /ai/jobs → subscribe WS for progress → on `succeeded` fetch the image
 *   artifact → hand it to a placement callback. A polling fallback covers a
 *   missed terminal WS message.
 *
 * The hook owns the phase/progress/error state and the socket disposer; callers
 * supply the request and a placement callback that receives the Blob plus the
 * artifact's placement metadata (so inpaint/outpaint can position the layer).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Capability,
  CreateJobRequest,
  CreateJobResponse,
  Job,
  JobArtifact,
} from "@aips/shared-types";
import { connectJobSocket, createJob, getJob } from "./apiClient";

export type AiJobPhase =
  | "idle"
  | "submitting"
  | "running"
  | "error"
  | "done";

export interface UseAiJob {
  phase: AiJobPhase;
  progress: number;
  stage: string;
  error: string | null;
  busy: boolean;
  /** Run a server job. Resolves when terminal (placed, errored, or directive). */
  run: <C extends Capability>(
    req: CreateJobRequest<C>,
    opts: {
      /** Place a successful job's primary image artifact. */
      onArtifact: (blob: Blob, artifact: JobArtifact) => Promise<void> | void;
      /**
       * Handle a `client_directive` response (e.g. run RMBG locally). When
       * provided and the server returns a directive, this is awaited instead of
       * the WS flow. Throw to surface an error.
       */
      onClientDirective?: (
        directive: Extract<CreateJobResponse, { kind: "client_directive" }>,
      ) => Promise<void> | void;
    },
  ) => Promise<void>;
  /** Manually drive external (client-side) progress, e.g. RMBG worker phases. */
  setExternalProgress: (progress: number, stage: string) => void;
  beginExternal: (stage?: string) => void;
  finishExternal: () => void;
  failExternal: (message: string) => void;
  reset: () => void;
}

export function useAiJob(): UseAiJob {
  const [phase, setPhase] = useState<AiJobPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const disposerRef = useRef<(() => void) | null>(null);
  // Guards against late WS/poll updates touching state after a terminal phase.
  const settledRef = useRef(false);

  useEffect(() => () => disposerRef.current?.(), []);

  const teardown = useCallback(() => {
    disposerRef.current?.();
    disposerRef.current = null;
  }, []);

  const reset = useCallback(() => {
    teardown();
    settledRef.current = false;
    setPhase("idle");
    setProgress(0);
    setStage("");
    setError(null);
  }, [teardown]);

  const run = useCallback<UseAiJob["run"]>(async (req, opts) => {
    teardown();
    settledRef.current = false;
    setError(null);
    setProgress(0);
    setStage("queued");
    setPhase("submitting");

    const handleJob = async (job: Job): Promise<void> => {
      if (settledRef.current) return;
      setProgress(job.progress);
      setStage(job.stage);
      if (job.status === "succeeded") {
        settledRef.current = true;
        teardown();
        const art =
          job.artifacts.find((a) => a.kind === "image") ?? job.artifacts[0];
        if (!art) {
          setError("Job finished but returned no artifact.");
          setPhase("error");
          return;
        }
        try {
          const res = await fetch(art.url);
          if (!res.ok) throw new Error(`Artifact fetch ${res.status}`);
          const blob = await res.blob();
          await opts.onArtifact(blob, art);
          setProgress(1);
          setPhase("done");
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
      } else if (job.status === "failed" || job.status === "canceled") {
        settledRef.current = true;
        teardown();
        setError(job.error?.message ?? `Job ${job.status}.`);
        setPhase("error");
      } else {
        setPhase("running");
      }
    };

    const pollUntilDone = async (jobId: string): Promise<void> => {
      // Since a WS transport error is no longer terminal (the poll is the safety
      // net), the poll must surface a sustained API outage itself — otherwise a
      // fully-down backend would spin silently. Bail with an error after enough
      // consecutive poll failures.
      let consecutiveFailures = 0;
      for (let i = 0; i < 200 && !settledRef.current; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        if (settledRef.current) return;
        try {
          const job = await getJob(jobId);
          consecutiveFailures = 0;
          if (
            job.status === "succeeded" ||
            job.status === "failed" ||
            job.status === "canceled"
          ) {
            await handleJob(job);
            return;
          }
        } catch {
          // WS is primary; tolerate transient poll errors, but a long run of
          // them (≈30s) with no WS progress means the backend is unreachable.
          consecutiveFailures++;
          if (consecutiveFailures >= 20 && !settledRef.current) {
            settledRef.current = true;
            teardown();
            setError("Lost connection to the server.");
            setPhase("error");
            return;
          }
        }
      }
    };

    try {
      const resp = await createJob(req);
      if (resp.kind === "client_directive") {
        if (opts.onClientDirective) {
          await opts.onClientDirective(resp);
          // onClientDirective drives its own phase via the external* helpers.
          return;
        }
        setError(
          `Server returned a client directive for ${req.capability}, but this action runs server-side.`,
        );
        setPhase("error");
        return;
      }
      setPhase("running");
      disposerRef.current = connectJobSocket(
        resp.job.id,
        (job) => void handleJob(job),
        (code, message) => {
          if (settledRef.current) return;
          // Transport-level socket failures are NOT terminal: the 1.5s poll
          // fallback (started below) is the safety net for a missing/broken WS.
          // Only a server-sent application error (`type: "error"`) settles here.
          if (code === "ws_error") return;
          settledRef.current = true;
          teardown();
          setError(message);
          setPhase("error");
        },
      );
      await handleJob(resp.job);
      void pollUntilDone(resp.job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [teardown]);

  const beginExternal = useCallback((s = "starting") => {
    teardown();
    settledRef.current = false;
    setError(null);
    setProgress(0);
    setStage(s);
    setPhase("running");
  }, [teardown]);

  const setExternalProgress = useCallback((p: number, s: string) => {
    setProgress(p);
    setStage(s);
  }, []);

  const finishExternal = useCallback(() => {
    settledRef.current = true;
    setProgress(1);
    setPhase("done");
  }, []);

  const failExternal = useCallback((message: string) => {
    settledRef.current = true;
    setError(message);
    setPhase("error");
  }, []);

  const busy = phase === "submitting" || phase === "running";

  return {
    phase,
    progress,
    stage,
    error,
    busy,
    run,
    setExternalProgress,
    beginExternal,
    finishExternal,
    failExternal,
    reset,
  };
}
