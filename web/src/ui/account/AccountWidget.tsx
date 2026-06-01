/**
 * AccountWidget — the credit meter in the top bar.
 *
 * Compact pill shows the live credit balance; clicking it opens a dark popover
 * with the signed-in identity, a dev "Add credits" top-up (hits
 * /admin/credits/grant, authorized by the dev-user's admin JWT), and a compact
 * history of the last billed calls (GET /account/usage). It also renders a thin
 * shared banner whenever any AI call hit 402 (insufficient credits) or 429
 * (rate limited), so the user always learns WHY a call failed regardless of
 * which AI tab they were on.
 *
 * Frictionless self-host: on mount it kicks the transparent dev-login (which
 * also seeds the dev-user's 1,000,000-credit grant), so the meter populates and
 * the first job never 402s. No secret is in the bundle — only the server-minted
 * token and credit counts.
 */
import { useEffect, useRef, useState } from "react";
import {
  useAccount,
  initAccount,
  refreshAccount,
  refreshBalance,
  addCredits,
} from "./accountStore";
import { subscribeApiNotice, type ApiNotice } from "../../ai/apiError";

/** A dev top-up amount. 1 credit ≈ $0.01; 100k credits ≈ $1,000 of headroom. */
const TOPUP_CREDITS = 100_000;

/** Poll the balance lightly so the meter stays current after jobs settle. */
const BALANCE_POLL_MS = 15_000;

function formatCredits(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

export function AccountWidget() {
  const acct = useAccount();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<ApiNotice | null>(null);
  const [granting, setGranting] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Boot: transparent dev-login + initial load. Idempotent.
  useEffect(() => {
    void initAccount();
  }, []);

  // Light balance polling so settled-job refunds/charges show up.
  useEffect(() => {
    const id = setInterval(() => void refreshBalance(), BALANCE_POLL_MS);
    return () => clearInterval(id);
  }, []);

  // Shared 402/429/401 surface: show the banner + pull a fresh balance (a job
  // just spent credits, was refunded, or was blocked).
  useEffect(() => {
    return subscribeApiNotice((n) => {
      setNotice(n);
      void refreshBalance();
      // Auto-dismiss after a while so it doesn't linger forever.
      window.setTimeout(() => {
        setNotice((cur) => (cur && cur.at === n.at ? null : cur));
      }, 12_000);
    });
  }, []);

  // Close the popover on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Refresh the full account (incl. usage) whenever the popover opens.
  useEffect(() => {
    if (open) void refreshAccount();
  }, [open]);

  async function onAddCredits() {
    setGranting(true);
    try {
      await addCredits(TOPUP_CREDITS);
    } catch {
      // The store already recorded a notice; nothing more to do here.
    } finally {
      setGranting(false);
    }
  }

  const low = acct.balanceCredits != null && acct.balanceCredits < 20;

  // Compact balance for the toolbar trigger (the full number + "credits" label
  // overflowed the bar on laptops). The popover shows the precise figure.
  const balShort = (() => {
    const b = acct.balanceCredits;
    if (b == null) return "—";
    if (b >= 1_000_000) return `${(b / 1_000_000).toFixed(b >= 10_000_000 ? 0 : 1)}M`;
    if (b >= 10_000) return `${Math.round(b / 1000)}k`;
    return b.toLocaleString();
  })();

  return (
    <div className="relative" ref={rootRef}>
      {/* Shared error banner (402/429). Anchored under the bar via fixed-ish
          absolute positioning relative to the widget. */}
      {notice && (
        <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />
      )}

      <button
        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium tabular-nums transition-colors ${
          low
            ? "border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
            : "border-edge bg-panelraised text-ink hover:bg-edge"
        }`}
        onClick={() => setOpen((o) => !o)}
        title={`Credits & account — ${formatCredits(acct.balanceCredits)} credits`}
      >
        <CoinIcon />
        {balShort}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl">
          {/* Identity + balance header */}
          <div className="flex items-center justify-between border-b border-edge px-3 py-2.5">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-ink">
                {acct.userId ?? "Not signed in"}
              </div>
              <div className="text-[11px] text-muted">
                {acct.isAdmin ? "Admin · self-host" : "Member"}
              </div>
            </div>
            <div className="text-right">
              <div className="text-lg font-semibold tabular-nums text-ink">
                {formatCredits(acct.balanceCredits)}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-muted">
                credits
              </div>
            </div>
          </div>

          {acct.notice && (
            <div className="border-b border-edge bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
              {acct.notice}
            </div>
          )}

          {/* Dev top-up */}
          <div className="flex items-center gap-2 border-b border-edge px-3 py-2.5">
            <button
              className="btn btn-accent flex-1"
              onClick={onAddCredits}
              disabled={granting || !acct.userId}
              title="Grant dev credits (self-host)"
            >
              {granting
                ? "Adding…"
                : `+ Add ${TOPUP_CREDITS.toLocaleString()} credits`}
            </button>
            <button
              className="btn"
              onClick={() => void refreshAccount()}
              disabled={acct.loading}
              title="Refresh"
            >
              {acct.loading ? "…" : "↻"}
            </button>
          </div>

          {/* Usage history */}
          <div className="max-h-72 overflow-y-auto">
            <div className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
              Recent usage
            </div>
            {acct.usage.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted">
                No billed calls yet.
              </div>
            ) : (
              <ul className="divide-y divide-edge/60 py-1">
                {acct.usage.map((u, i) => (
                  <li
                    key={`${u.jobId ?? "sync"}-${i}`}
                    className="flex items-center justify-between gap-2 px-3 py-1.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs text-ink">
                        {prettyCapability(u.capability)}
                      </div>
                      <div className="truncate text-[10px] text-muted">
                        {u.model ?? "local"}
                        {u.latencyMs != null
                          ? ` · ${(u.latencyMs / 1000).toFixed(1)}s`
                          : ""}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xs font-medium tabular-nums text-ink">
                        −{u.billedCredits}
                      </div>
                      <div className="text-[10px] tabular-nums text-muted">
                        {timeAgo(u.createdAt)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NoticeBanner({
  notice,
  onDismiss,
}: {
  notice: ApiNotice;
  onDismiss: () => void;
}) {
  const text =
    notice.kind === "insufficient_credits"
      ? `Out of credits — this needs ${notice.required ?? "?"}, you have ${
          notice.balance ?? 0
        }. Add credits to continue.`
      : notice.kind === "rate_limited"
        ? `Rate limited — try again in ${
            notice.retryAfterSeconds ?? "a few"
          }s.`
        : "Session expired — reconnecting.";
  const tone =
    notice.kind === "insufficient_credits"
      ? "border-amber-500/50 bg-amber-500/15 text-amber-200"
      : notice.kind === "rate_limited"
        ? "border-sky-500/50 bg-sky-500/15 text-sky-200"
        : "border-rose-500/50 bg-rose-500/15 text-rose-200";
  return (
    <div
      className={`absolute right-0 top-full z-50 mt-1 flex w-80 items-start gap-2 rounded-md border px-3 py-2 text-[11px] shadow-2xl ${tone}`}
      role="status"
    >
      <span className="flex-1 leading-snug">{text}</span>
      <button
        className="shrink-0 text-current/70 hover:text-current"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

function CoinIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="opacity-80"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10M9.5 9.5h3.2a1.8 1.8 0 0 1 0 3.6H9.8h3.4a1.8 1.8 0 0 1 0 3.6H9" />
    </svg>
  );
}

/** "text_to_image" → "Text to image". */
function prettyCapability(cap: string): string {
  const s = cap.replace(/^sync:/, "").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Compact relative time from an ISO timestamp. */
function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
