/**
 * Channels panel — Photoshop-style RGB / Red / Green / Blue / Alpha rows.
 *
 * Each row has an eye toggle (engine.setChannelVisible via actions) and a small
 * thumbnail (engine.getChannelThumbnail). Interactions:
 *   - click a row's thumbnail/label → SOLO that channel (others off). The "RGB"
 *     composite row instead toggles ALL color channels on together.
 *   - click the eye → toggle just that one channel's visibility.
 *
 * Visibility is read reactively via useChannels(); the "RGB" composite row is
 * shown active whenever every color channel (R+G+B) is visible. Thumbnails are
 * regenerated whenever the document composite could have changed (a cheap
 * snapshot signature) or the panel mounts — they are async PNG blobs turned into
 * object URLs and revoked on replacement / unmount.
 *
 * Pure UI: all pixel work happens in the engine. React never touches pixels.
 */
import { useEffect, useRef, useState } from "react";
import { actions, useChannels, useEngineSnapshot, engine } from "../../state/useEngine";
import type { ChannelKey, ChannelVisibility } from "../../engine/EditorEngine";

/** Thumbnail row keys: the four real channels plus the synthetic composite. */
type RowKey = ChannelKey | "rgb";

interface RowDef {
  key: RowKey;
  label: string;
  /** Tailwind accent dot color so rows are scannable at a glance. */
  dot: string;
}

const ROWS: RowDef[] = [
  { key: "rgb", label: "RGB", dot: "bg-gradient-to-br from-red-500 via-green-500 to-blue-500" },
  { key: "r", label: "Red", dot: "bg-red-500" },
  { key: "g", label: "Green", dot: "bg-green-500" },
  { key: "b", label: "Blue", dot: "bg-blue-500" },
  { key: "a", label: "Alpha", dot: "bg-white" },
];

/** Whether the composite (all three color channels) is currently visible. */
function rgbAllVisible(v: ChannelVisibility): boolean {
  return v.r && v.g && v.b;
}

/** Is this row's "active" state on? RGB → all color channels; else the channel. */
function rowActive(key: RowKey, v: ChannelVisibility): boolean {
  return key === "rgb" ? rgbAllVisible(v) : v[key];
}

/**
 * Solo a single channel: turn it on and everything else off. For the composite
 * row, turn all three color channels on and alpha off (the standard "RGB" view).
 */
function soloChannel(key: RowKey): void {
  if (key === "rgb") {
    actions.setChannelVisible("r", true);
    actions.setChannelVisible("g", true);
    actions.setChannelVisible("b", true);
    actions.setChannelVisible("a", false);
    return;
  }
  for (const ch of ["r", "g", "b", "a"] as ChannelKey[]) {
    actions.setChannelVisible(ch, ch === key);
  }
}

/** Toggle one channel's eye. The RGB row toggles all three color channels. */
function toggleEye(key: RowKey, v: ChannelVisibility): void {
  if (key === "rgb") {
    const next = !rgbAllVisible(v);
    actions.setChannelVisible("r", next);
    actions.setChannelVisible("g", next);
    actions.setChannelVisible("b", next);
    return;
  }
  actions.setChannelVisible(key, !v[key]);
}

/** Open (visible) / closed (hidden) eye glyph. */
function EyeIcon({ on }: { on: boolean }) {
  return on ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l18 18" />
      <path d="M10.6 6.2A9.8 9.8 0 0 1 12 6c7 0 10.5 6.5 10.5 6.5a17 17 0 0 1-3.3 3.9M6.3 7.8A17 17 0 0 0 1.5 12.5S5 19 12 19a9.5 9.5 0 0 0 3.4-.6" />
      <path d="M9.9 10.1a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

/**
 * One channel row. The thumbnail blob URL is owned by the parent (passed in)
 * so regeneration is centralized; this is a presentational button + eye.
 */
function ChannelRow({
  def,
  active,
  url,
  onSolo,
  onToggleEye,
}: {
  def: RowDef;
  active: boolean;
  url: string | null;
  onSolo: () => void;
  onToggleEye: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors ${
        active
          ? "border-edge bg-panelraised"
          : "border-transparent hover:border-edge hover:bg-panelraised/60"
      }`}
    >
      {/* Eye toggle (single-channel visibility). */}
      <button
        type="button"
        title={active ? "Hide channel" : "Show channel"}
        onClick={onToggleEye}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors ${
          active ? "text-ink" : "text-muted hover:text-ink"
        }`}
      >
        <EyeIcon on={active} />
      </button>

      {/* Thumbnail + label → solo this channel. */}
      <button
        type="button"
        title={def.key === "rgb" ? "Show all color channels" : `Solo ${def.label} channel`}
        onClick={onSolo}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span
          className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded border border-black/50 ring-1 ring-white/10"
          style={{
            backgroundImage:
              "linear-gradient(45deg, #444 25%, transparent 25%), linear-gradient(-45deg, #444 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #444 75%), linear-gradient(-45deg, transparent 75%, #444 75%)",
            backgroundSize: "8px 8px",
            backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0",
            backgroundColor: "#222",
          }}
        >
          {url ? (
            <img
              src={url}
              alt={`${def.label} channel`}
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <span className="text-[9px] text-muted">…</span>
          )}
        </span>

        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${def.dot} ${active ? "" : "opacity-40"}`} />
          <span className={`truncate text-xs font-medium ${active ? "text-ink" : "text-muted"}`}>
            {def.label}
          </span>
        </span>
      </button>
    </div>
  );
}

export function ChannelsPanel() {
  const channels = useChannels();
  const snap = useEngineSnapshot();

  // Object URLs per row, owned here so we can revoke on replacement / unmount.
  const [urls, setUrls] = useState<Record<RowKey, string | null>>({
    rgb: null,
    r: null,
    g: null,
    b: null,
    a: null,
  });
  const urlsRef = useRef(urls);
  urlsRef.current = urls;

  // Regenerate all five thumbnails whenever the document composite could have
  // changed. A coarse signature off the snapshot keeps this from firing every
  // render: pixels live in the engine, but layer count / order / visibility /
  // opacity / blend and active layer are the cheap proxies the snapshot exposes.
  const docSig =
    `${snap.width}x${snap.height}|${snap.activeLayerId ?? ""}|` +
    snap.layers
      .map((l) => `${l.id}:${l.visible ? 1 : 0}:${l.opacity}:${l.blendMode}`)
      .join(",");

  useEffect(() => {
    let live = true;
    const keys: RowKey[] = ["rgb", "r", "g", "b", "a"];
    void Promise.all(
      keys.map((k) =>
        engine.getChannelThumbnail(k, 72).then((blob) => ({
          k,
          url: blob ? URL.createObjectURL(blob) : null,
        })),
      ),
    ).then((results) => {
      if (!live) {
        // Component (or this effect) is stale — drop any URLs we just made.
        for (const { url } of results) if (url) URL.revokeObjectURL(url);
        return;
      }
      const next: Record<RowKey, string | null> = { rgb: null, r: null, g: null, b: null, a: null };
      for (const { k, url } of results) next[k] = url;
      // Revoke the previous batch now that the new one is in place.
      const prev = urlsRef.current;
      setUrls(next);
      for (const k of keys) {
        const p = prev[k];
        if (p && p !== next[k]) URL.revokeObjectURL(p);
      }
    });
    return () => {
      live = false;
    };
    // docSig is the intentional, cheap dependency (snapshot proxy for pixels).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docSig]);

  // Revoke any outstanding URLs on unmount.
  useEffect(() => {
    return () => {
      const cur = urlsRef.current;
      for (const k of Object.keys(cur) as RowKey[]) {
        const u = cur[k];
        if (u) URL.revokeObjectURL(u);
      }
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="panel-title border-b border-edge">Channels</div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {ROWS.map((def) => {
          const active = rowActive(def.key, channels);
          return (
            <ChannelRow
              key={def.key}
              def={def}
              active={active}
              url={urls[def.key]}
              onSolo={() => soloChannel(def.key)}
              onToggleEye={() => toggleEye(def.key, channels)}
            />
          );
        })}
      </div>

      <div className="shrink-0 border-t border-edge px-3 py-2 text-[10px] leading-snug text-muted">
        Click a channel to solo it · click the eye to toggle · RGB toggles all colors
      </div>
    </div>
  );
}
