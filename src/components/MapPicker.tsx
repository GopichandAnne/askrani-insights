"use client";

import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";

/**
 * Reusable "pick on a map" surface built on Leaflet + OpenStreetMap (free, no
 * API key). Renders branded pins for each point; clicking a pin opens a popup
 * with the name and an action button (Select / Add / Remove) wired to onPick.
 * Leaflet is dynamically imported inside an effect so it never touches the DOM
 * during SSR.
 */

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  label: string;
  sub?: string;
  tone?: "target" | "competitor" | "result" | "muted";
  action?: string; // popup button label; omit for no action
}

const TONE: Record<string, string> = {
  target: "#0d9488",     // brand
  competitor: "#0f766e", // brand-deep
  result: "#fb7185",     // coral
  muted: "#94a3b8",
};

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

export function MapPicker({
  points,
  onPick,
  height = 340,
  className = "",
}: {
  points: MapPoint[];
  onPick?: (id: string) => void;
  height?: number;
  className?: string;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const LRef = useRef<any>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const pointsRef = useRef(points);
  pointsRef.current = points;

  function render() {
    const L = LRef.current, map = mapRef.current;
    if (!L || !map) return;
    if (layerRef.current) layerRef.current.remove();
    const layer = L.layerGroup().addTo(map);
    layerRef.current = layer;

    const valid = pointsRef.current.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    const bounds: [number, number][] = [];
    for (const p of valid) {
      const color = TONE[p.tone ?? "result"];
      const big = p.tone === "target";
      const size = big ? 24 : 18;
      const icon = L.divIcon({
        className: "",
        html: `<span style="display:block;width:${size}px;height:${size}px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${color};border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35)"></span>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size],
        popupAnchor: [0, -size + 2],
      });
      const btn = p.action && onPickRef.current
        ? `<button data-pick="${esc(p.id)}" style="margin-top:8px;width:100%;cursor:pointer;border:none;border-radius:9999px;background:linear-gradient(135deg,#0d9488,#0f766e);color:#fff;font-weight:600;font-size:12px;padding:6px 10px">${esc(p.action)}</button>`
        : "";
      const popup = `<div style="min-width:150px;font-family:inherit"><div style="font-weight:700;font-size:13px">${esc(p.label)}</div>${p.sub ? `<div style="opacity:.65;font-size:11px;margin-top:2px">${esc(p.sub)}</div>` : ""}${btn}</div>`;
      L.marker([p.lat, p.lng], { icon, title: p.label, riseOnHover: true }).addTo(layer).bindPopup(popup);
      bounds.push([p.lat, p.lng]);
    }

    if (bounds.length === 1) map.setView(bounds[0], 14);
    else if (bounds.length > 1) map.fitBounds(bounds, { padding: [42, 42], maxZoom: 15 });
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !elRef.current || mapRef.current) return;
      LRef.current = L;
      const map = L.map(elRef.current, { scrollWheelZoom: false, zoomControl: true }).setView([39.5, -98.35], 4);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      map.on("popupopen", (e: any) => {
        const node = e.popup.getElement()?.querySelector("[data-pick]");
        if (node) node.addEventListener("click", () => { onPickRef.current?.(node.getAttribute("data-pick")); map.closePopup(); }, { once: true });
      });
      mapRef.current = map;
      render();
    })();
    return () => { cancelled = true; };
  }, []);

  // re-render markers whenever the point set changes
  useEffect(() => { render(); }, [points]); // eslint-disable-line react-hooks/exhaustive-deps

  // tear down on unmount
  useEffect(() => () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } }, []);

  return (
    <div
      ref={elRef}
      className={`overflow-hidden rounded-2xl border border-line/60 ${className}`}
      style={{ height }}
      role="application"
      aria-label="Map"
    />
  );
}
