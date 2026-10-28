import { randomLcg, randomNormal } from "d3";

/** Deterministic fixtures shared by unit, integration, browser tests and examples. */

export const sales = [
  { region: "North", product: "Router", quarter: "Q1", revenue: 120, units: 30 },
  { region: "North", product: "Switch", quarter: "Q1", revenue: 80, units: 44 },
  { region: "South", product: "Router", quarter: "Q1", revenue: 95, units: 25 },
  { region: "South", product: "Switch", quarter: "Q1", revenue: 60, units: 31 },
  { region: "East", product: "Router", quarter: "Q1", revenue: 150, units: 41 },
  { region: "East", product: "Switch", quarter: "Q1", revenue: 70, units: 35 },
  { region: "West", product: "Router", quarter: "Q1", revenue: 40, units: 12 },
  { region: "West", product: "Switch", quarter: "Q1", revenue: 55, units: 29 },
  { region: "North", product: "Router", quarter: "Q2", revenue: 130, units: 33 },
  { region: "South", product: "Switch", quarter: "Q2", revenue: 66, units: 34 },
  { region: "East", product: "Router", quarter: "Q2", revenue: 160, units: 45 },
  { region: "West", product: "Switch", quarter: "Q2", revenue: 58, units: 30 },
];

export const simpleBars = [
  { category: "A", value: 30 },
  { category: "B", value: 80 },
  { category: "C", value: 45 },
  { category: "D", value: 60 },
  { category: "E", value: 20 },
];

/** SD-WAN style telemetry: 3 sites × 48 hourly samples. */
export function telemetryCsv(): string {
  const rng = randomLcg(7);
  const sites = ["SJC", "NYC", "LON"];
  const lines = ["timestamp,site,latency_ms,packet_loss_pct,throughput_mbps"];
  const start = Date.UTC(2026, 9, 1);
  for (let h = 0; h < 48; h++) {
    for (const [i, s] of sites.entries()) {
      const t = new Date(start + h * 3_600_000).toISOString().replace(".000Z", "Z");
      const base = 20 + i * 35;
      const spike = s === "LON" && h >= 30 && h <= 33 ? 120 : 0;
      const latency = Math.round((base + 8 * Math.sin(h / 4) + rng() * 5 + spike) * 10) / 10;
      const loss = Math.round((0.2 + rng() * 0.3 + (spike ? 2.5 : 0)) * 100) / 100;
      const thr = Math.round(400 + i * 150 - spike * 1.5 + rng() * 40);
      lines.push(`${t},${s},${latency},${loss},${thr}`);
    }
  }
  return lines.join("\n");
}

export const network = {
  nodes: [
    { id: "hub-sjc", group: "hub", label: "Hub SJC" },
    { id: "hub-nyc", group: "hub", label: "Hub NYC" },
    { id: "hub-lon", group: "hub", label: "Hub LON" },
    { id: "br-sfo", group: "branch", label: "Branch SFO" },
    { id: "br-sea", group: "branch", label: "Branch SEA" },
    { id: "br-bos", group: "branch", label: "Branch BOS" },
    { id: "br-chi", group: "branch", label: "Branch CHI" },
    { id: "br-par", group: "branch", label: "Branch PAR" },
    { id: "br-ber", group: "branch", label: "Branch BER" },
    { id: "dc-1", group: "datacenter", label: "DC 1" },
    { id: "dc-2", group: "datacenter", label: "DC 2" },
    { id: "cloud", group: "cloud", label: "Cloud GW" },
  ],
  links: [
    { source: "hub-sjc", target: "hub-nyc", value: 10 },
    { source: "hub-nyc", target: "hub-lon", value: 8 },
    { source: "hub-sjc", target: "hub-lon", value: 4 },
    { source: "br-sfo", target: "hub-sjc", value: 3 },
    { source: "br-sea", target: "hub-sjc", value: 2 },
    { source: "br-bos", target: "hub-nyc", value: 3 },
    { source: "br-chi", target: "hub-nyc", value: 2 },
    { source: "br-par", target: "hub-lon", value: 3 },
    { source: "br-ber", target: "hub-lon", value: 2 },
    { source: "dc-1", target: "hub-sjc", value: 9 },
    { source: "dc-2", target: "hub-nyc", value: 9 },
    { source: "cloud", target: "hub-sjc", value: 6 },
    { source: "cloud", target: "hub-lon", value: 5 },
  ],
};

/** Three-tier campus + WAN topology with device types for icon tests and examples. */
export const topology = {
  nodes: [
    { id: "internet", label: "Internet", type: "internet", tier: "wan", site: "WAN" },
    { id: "fw-1", label: "FW-1", type: "firewall", tier: "edge", site: "HQ" },
    { id: "fw-2", label: "FW-2", type: "fw", tier: "edge", site: "HQ" },
    { id: "core-1", label: "Core-1", type: "router", tier: "core", site: "HQ" },
    { id: "core-2", label: "Core-2", type: "router", tier: "core", site: "HQ" },
    { id: "dist-1", label: "Dist-1", type: "l3-switch", tier: "distribution", site: "HQ" },
    { id: "dist-2", label: "Dist-2", type: "l3-switch", tier: "distribution", site: "HQ" },
    { id: "acc-1", label: "Acc-1", type: "switch", tier: "access", site: "HQ" },
    { id: "acc-2", label: "Acc-2", type: "switch", tier: "access", site: "HQ" },
    { id: "acc-3", label: "Acc-3", type: "switch", tier: "access", site: "HQ" },
    { id: "ap-1", label: "AP-1", type: "ap", tier: "endpoint", site: "HQ" },
    { id: "srv-1", label: "App server", type: "server", tier: "endpoint", site: "DC" },
    { id: "db-1", label: "DB", type: "database", tier: "endpoint", site: "DC" },
    { id: "pc-1", label: "PC", type: "pc", tier: "endpoint", site: "HQ" },
  ],
  links: [
    { source: "internet", target: "fw-1" },
    { source: "internet", target: "fw-2" },
    { source: "fw-1", target: "core-1" },
    { source: "fw-2", target: "core-2" },
    { source: "core-1", target: "core-2", value: 4 },
    { source: "core-1", target: "dist-1" },
    { source: "core-2", target: "dist-2" },
    { source: "core-1", target: "dist-2" },
    { source: "core-2", target: "dist-1" },
    { source: "dist-1", target: "acc-1" },
    { source: "dist-1", target: "acc-2" },
    { source: "dist-2", target: "acc-3" },
    { source: "acc-1", target: "ap-1" },
    { source: "acc-2", target: "pc-1" },
    { source: "acc-3", target: "srv-1" },
    { source: "acc-3", target: "db-1" },
  ],
};

export const TIER_ORDER = ["wan", "edge", "core", "distribution", "access", "endpoint"];

/** A user-supplied SVG icon (lucide-style) used to test custom icon parsing. */
export const customSvgIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="7" cy="12" r="2"/><g transform="translate(1 0)"><polyline points="12 10 15 12 12 14"/><line x1="16" y1="12" x2="19" y2="12"/></g></svg>';

export const flows = {
  nodes: [
    { id: "Internet" },
    { id: "Firewall" },
    { id: "Web" },
    { id: "API" },
    { id: "DB" },
    { id: "Cache" },
  ],
  links: [
    { source: "Internet", target: "Firewall", value: 100 },
    { source: "Firewall", target: "Web", value: 70 },
    { source: "Firewall", target: "API", value: 30 },
    { source: "Web", target: "API", value: 40 },
    { source: "API", target: "DB", value: 45 },
    { source: "API", target: "Cache", value: 25 },
  ],
};

export const hierarchy = {
  name: "Network",
  children: [
    {
      name: "Americas",
      children: [
        { name: "SJC", value: 420 },
        { name: "NYC", value: 380 },
        { name: "SFO", value: 120 },
        { name: "CHI", value: 90 },
      ],
    },
    {
      name: "EMEA",
      children: [
        { name: "LON", value: 300 },
        { name: "PAR", value: 110 },
        { name: "BER", value: 85 },
      ],
    },
    {
      name: "APAC",
      children: [
        { name: "TYO", value: 260 },
        { name: "SYD", value: 140 },
        { name: "SIN", value: 160 },
      ],
    },
  ],
};

function square(lon: number, lat: number, size: number): number[][][] {
  // Counter-clockwise exterior ring per RFC 7946 (d3-geo expects clockwise; the renderer rewinds).
  return [
    [
      [lon, lat],
      [lon + size, lat],
      [lon + size, lat + size],
      [lon, lat + size],
      [lon, lat],
    ],
  ];
}

export const geo = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Alpha", value: 10 },
      geometry: { type: "Polygon", coordinates: square(-10, 40, 5) },
    },
    {
      type: "Feature",
      properties: { name: "Bravo", value: 25 },
      geometry: { type: "Polygon", coordinates: square(-5, 40, 5) },
    },
    {
      type: "Feature",
      properties: { name: "Charlie", value: 40 },
      geometry: { type: "Polygon", coordinates: square(0, 40, 5) },
    },
    {
      type: "Feature",
      properties: { name: "Delta", value: 55 },
      geometry: { type: "Polygon", coordinates: square(-10, 45, 5) },
    },
    {
      type: "Feature",
      properties: { name: "Echo", value: 70 },
      geometry: { type: "Polygon", coordinates: square(-5, 45, 5) },
    },
    {
      type: "Feature",
      properties: { name: "Foxtrot", value: 85 },
      geometry: { type: "Polygon", coordinates: square(0, 45, 5) },
    },
  ],
};

export const cities = [
  { city: "San Jose", lat: 37.34, lon: -121.89, users: 1200 },
  { city: "New York", lat: 40.71, lon: -74.0, users: 3400 },
  { city: "London", lat: 51.5, lon: -0.12, users: 2900 },
  { city: "Tokyo", lat: 35.68, lon: 139.69, users: 3100 },
  { city: "Sydney", lat: -33.87, lon: 151.21, users: 900 },
  { city: "São Paulo", lat: -23.55, lon: -46.63, users: 1500 },
];

export function scatterPoints(
  n = 200,
  seed = 3,
): Array<{ x: number; y: number; cluster: string; id: string }> {
  const rng = randomLcg(seed);
  const norm = randomNormal.source(rng);
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = i % 3;
    const nx = norm(c * 4, 1)();
    out.push({
      id: `p${i}`,
      x: Math.round(nx * 100) / 100,
      y: Math.round((nx * 1.5 + norm(c * 2, 1.2)()) * 100) / 100,
      cluster: ["a", "b", "c"][c]!,
    });
  }
  return out;
}

export const waterfall = [
  { step: "Start", delta: 100 },
  { step: "New sites", delta: 40 },
  { step: "Churn", delta: -25 },
  { step: "Upsell", delta: 30 },
  { step: "Discounts", delta: -15 },
];

export const malicious = [
  { name: '<script>alert("x")</script>', value: 10 },
  { name: '"><img src=x onerror=alert(1)>', value: 20 },
  { name: "javascript:alert(1)", value: 30 },
  { name: "</svg><script>bad()</script>", value: 15 },
];

export function largeRecords(n: number): Array<{ x: number; y: number; g: string }> {
  const rng = randomLcg(11);
  return Array.from({ length: n }, (_, i) => ({ x: rng() * 100, y: rng() * 100, g: `g${i % 5}` }));
}
