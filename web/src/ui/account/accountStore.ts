/**
 * React-facing store for the signed-in identity, credit balance and recent
 * usage. Wraps the typed account client and the auth session store, and exposes
 * a `useAccount()` hook the AccountWidget renders.
 *
 * Design: a single module singleton holds the latest snapshot and notifies
 * subscribers; `useAccount()` is a thin `useSyncExternalStore` binding. The
 * widget triggers refreshes (on mount, on a light interval, after a top-up, and
 * whenever a global 402/429 notice fires — a job just spent or was blocked).
 */
import { useSyncExternalStore } from "react";
import type { CreditUsageEntry } from "@aips/shared-types";
import {
  ensureDevToken,
  getAuthState,
  subscribeAuth,
  type AuthState,
} from "../../ai/auth";
import {
  fetchMe,
  fetchUsage,
  fetchBalance,
  grantCredits,
} from "../../ai/accountClient";
import { ApiError } from "../../ai/apiError";

export interface AccountSnapshot {
  /** Whether the auth boot (dev-login/restore) has completed. */
  ready: boolean;
  userId: string | null;
  isAdmin: boolean;
  /** Null until first loaded. */
  balanceCredits: number | null;
  usage: CreditUsageEntry[];
  /** A non-fatal status/error to show in the widget (e.g. prod login needed). */
  notice: string | null;
  /** True while a network refresh is in flight. */
  loading: boolean;
}

let snap: AccountSnapshot = {
  ready: false,
  userId: null,
  isAdmin: false,
  balanceCredits: null,
  usage: [],
  notice: null,
  loading: false,
};

const listeners = new Set<() => void>();

function setSnap(patch: Partial<AccountSnapshot>): void {
  snap = { ...snap, ...patch };
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot(): AccountSnapshot {
  return snap;
}

// Mirror auth readiness/identity into the account snapshot.
subscribeAuth((a: AuthState) => {
  setSnap({
    ready: a.ready,
    userId: a.userId,
    notice: a.authError ?? snap.notice,
  });
});

/** Kick the transparent dev-login (idempotent) then load identity + balance. */
export async function initAccount(): Promise<void> {
  await ensureDevToken();
  const a = getAuthState();
  setSnap({ ready: a.ready, userId: a.userId, notice: a.authError });
  await refreshAccount();
}

/** Full refresh: identity + balance + usage. Tolerant of partial failures. */
export async function refreshAccount(): Promise<void> {
  setSnap({ loading: true });
  try {
    const [me, usage] = await Promise.all([fetchMe(), fetchUsage()]);
    setSnap({
      userId: me.userId,
      isAdmin: me.isAdmin,
      balanceCredits: me.balanceCredits,
      usage: usage.usage,
      notice: null,
      loading: false,
    });
  } catch (e) {
    setSnap({
      loading: false,
      notice: noticeFor(e),
    });
  }
}

/** Lightweight balance-only refresh (e.g. after a job or sync call). */
export async function refreshBalance(): Promise<void> {
  try {
    const b = await fetchBalance();
    setSnap({ balanceCredits: b.balanceCredits });
  } catch {
    // Silent — the widget keeps its last-known balance.
  }
}

/** Dev/self-host top-up. Returns the new balance; refreshes usage too. */
export async function addCredits(credits: number): Promise<void> {
  const userId = snap.userId;
  if (!userId) throw new Error("No active session.");
  setSnap({ loading: true });
  try {
    const res = await grantCredits({
      userId,
      credits,
      reason: "dev top-up",
    });
    setSnap({ balanceCredits: res.balanceCredits, notice: null });
    // Pull the fresh usage row(s) the grant produced.
    await refreshAccount();
  } catch (e) {
    setSnap({ loading: false, notice: noticeFor(e) });
    throw e;
  }
}

function noticeFor(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return "Session expired — reconnecting…";
    if (e.status === 403) return "Not authorized.";
    return e.message;
  }
  return e instanceof Error ? e.message : "Could not reach the server.";
}

/** React hook: the live account snapshot. */
export function useAccount(): AccountSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
