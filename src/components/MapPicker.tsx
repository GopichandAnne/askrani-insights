"use client";

import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";

/**
 * "Pick on a map" surface. Uses Google Maps when NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
 * is configured (familiar tiles + satellite + Street View), otherwise falls back
 * to Leaflet + OpenStreetMap (free, no key). Both share one interface: colored
 * pins per point, click → popup with the name and an action button wired to
 * onPick. Map libs only touch the DOM inside effects, so this is SSR-safe.
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

const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
function popupHtml(p: MapPoint, pickAttr: string) {
  const btn = p.action
    ? `<button ${pickAttr}="${esc(p.id)}" style="margin-top:8px;width:100%;cursor:pointer;border:none;border-radius:9999px;background:linear-gradient(135deg,#0d9488,#0f766e);color:#fff;font-weight:600;font-size:12px;padding:6px 10px">${esc(p.action)}</button>`
    : "";
  return `<div style="min-width:150px;font-family:inherit"><div style="font-weight:700;font-size:13px;color:#0f172a">${esc(p.label)}</div>${p.sub ? `<div style="opacity:.65;font-size:11px;margin-top:2px;color:#0f172a">${esc(p.sub)}</div>` : ""}${btn}</div>`;
}
const validPt = (p: MapPoint) => Number.isFinite(p.lat) && Number.isFinite(p.lng);

// ── public component: choose provider ────────────────────────────────────────
export function MapPicker(props: { points: MapPoint[]; onPick?: (id: string) => void; height?: number; className?: string }) {
  return GOOGLE_KEY ? <GoogleMap {...props} /> : <LeafletMap {...props} />;
}

// ── Google Maps implementation ───────────────────────────────────────────────
let gmapsPromise: Promise<any> | null = null;
function loadGoogle(key: string): Promise<any> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if ((window as any).google?.maps) return Promise.resolve((window as any).google);
  if (gmapsPromise) return gmapsPromise;
  gmapsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve((window as any).google);
    s.onerror = () => reject(new Error("google maps failed to load"));
    document.head.appendChild(s);
  });
  return gmapsPromise;
}

function pinIcon(google: any, color: string, big: boolean) {
  return {
    path: "M12 0C7 0 3 4 3 9c0 6.5 9 15 9 15s9-8.5 9-15c0-5-4-9-9-9z",
    fillColor: color,
    fillOpacity: 1,
    strokeColor: "#ffffff",
    strokeWeight: 2,
    scale: big ? 1.7 : 1.25,
    anchor: new google.maps.Point(12, 24),
  };
}

function GoogleMap({ points, onPick, height = 340, className = "" }: { points: MapPoint[]; onPick?: (id: string) => void; height?: number; className?: string }) {
  const elRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const pointsRef = useRef(points);
  pointsRef.current = points;

  function render() {
    const st = stateRef.current;
    if (!st) return;
    const { google, map, info } = st;
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];
    const bounds = new google.maps.LatLngBounds();
    for (const p of pointsRef.current.filter(validPt)) {
      const marker = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        map,
        title: p.label,
        icon: pinIcon(google, TONE[p.tone ?? "result"], p.tone === "target"),
        zIndex: p.tone === "target" ? 999 : undefined,
      });
      marker.addListener("click", () => {
        info.setContent(popupHtml(p, "data-gpick"));
        info.open({ map, anchor: marker });
        google.maps.event.addListenerOnce(info, "domready", () => {
          const btn = document.querySelector("[data-gpick]") as HTMLElement | null;
          if (btn) btn.addEventListener("click", () => { onPickRef.current?.(btn.getAttribute("data-gpick")!); info.close(); }, { once: true });
        });
      });
      markersRef.current.push(marker);
      bounds.extend(marker.getPosition());
    }
    if (markersRef.current.length === 1) { map.setCenter(bounds.getCenter()); map.setZoom(14); }
    else if (markersRef.current.length > 1) map.fitBounds(bounds, 48);
  }

  useEffect(() => {
    let cancelled = false;
    loadGoogle(GOOGLE_KEY!).then((google) => {
      if (cancelled || !elRef.current || stateRef.current) return;
      const map = new google.maps.Map(elRef.current, {
        center: { lat: 39.5, lng: -98.35 },
        zoom: 4,
        mapTypeControl: true,
        streetViewControl: true,
        fullscreenControl: true,
        gestureHandling: "cooperative",
        clickableIcons: false,
      });
      stateRef.current = { google, map, info: new google.maps.InfoWindow() };
      render();
    }).catch(() => { /* key/network issue — surface empty box rather than crash */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { render(); }, [points]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={elRef} className={`overflow-hidden rounded-2xl border border-line/60 ${className}`} style={{ height }} role="application" aria-label="Map" />;
}

// ── Leaflet + OpenStreetMap implementation (free fallback) ───────────────────
function LeafletMap({ points, onPick, height = 340, className = "" }: { points: MapPoint[]; onPick?: (id: string) => void; height?: number; className?: string }) {
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

    const bounds: [number, number][] = [];
    for (const p of pointsRef.current.filter(validPt)) {
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
      L.marker([p.lat, p.lng], { icon, title: p.label, riseOnHover: true }).addTo(layer).bindPopup(popupHtml(p, "data-pick"));
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

  useEffect(() => { render(); }, [points]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } }, []);

  return <div ref={elRef} className={`overflow-hidden rounded-2xl border border-line/60 ${className}`} style={{ height }} role="application" aria-label="Map" />;
}
