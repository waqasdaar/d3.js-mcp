/** Write sample data files in every supported input format to examples/data-files/. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as d3 from "d3";
import * as XLSX from "xlsx";
import { stringify as toYaml } from "yaml";
import { PACKAGE_ROOT } from "../src/shared/config.js";
import { geo, hierarchy, sales, telemetryCsv, topology } from "../tests/fixtures/data.js";

const DIR = path.join(PACKAGE_ROOT, "examples", "data-files");
mkdirSync(DIR, { recursive: true });
const out = (name: string, content: string | Buffer) => {
  writeFileSync(path.join(DIR, name), content);
  process.stderr.write(`wrote examples/data-files/${name}\n`);
};

const header = Object.keys(sales[0]!);
const lines = (sep: string) =>
  [header.join(sep), ...sales.map((r) => header.map((h) => r[h as keyof typeof r]).join(sep))].join("\n") +
  "\n";

out("sales.csv", lines(","));
out(
  "sales-semicolon.csv",
  "region;product;revenue_eur;margin_pct\nNorth;Router;1.234,50;12,5\nSouth;Switch;980,25;9,75\nEast;Router;2.010,00;14\n",
);
out("sales.tsv", lines("\t"));
out("sales.psv", lines("|"));
out("telemetry.csv", telemetryCsv() + "\n");
out("sales.json", JSON.stringify(sales, null, 2) + "\n");
out(
  "sales-wrapped.json",
  JSON.stringify({ meta: { source: "erp", generated: "2026-10-01" }, data: sales }, null, 2) + "\n",
);
out("sales.jsonl", sales.map((r) => JSON.stringify(r)).join("\n") + "\n");
out("sales.yaml", toYaml({ title: "Quarterly sales", records: sales }));
out("topology.yaml", toYaml(topology));
out("org.yaml", toYaml(hierarchy));
out("regions.geojson", JSON.stringify(geo) + "\n");

// TopoJSON with shared arcs between two adjacent squares (hand-built so no extra tooling is needed).
out(
  "regions.topojson",
  JSON.stringify({
    type: "Topology",
    arcs: [
      [
        [0, 40],
        [0, 45],
      ],
      [
        [0, 45],
        [-5, 45],
        [-5, 40],
        [0, 40],
      ],
      [
        [0, 40],
        [5, 40],
        [5, 45],
        [0, 45],
      ],
    ],
    objects: {
      regions: {
        type: "GeometryCollection",
        geometries: [
          { type: "Polygon", arcs: [[0, 1]], properties: { name: "West", value: 30 } },
          { type: "Polygon", arcs: [[2, ~0]], properties: { name: "East", value: 70 } },
        ],
      },
    },
  }) + "\n",
);

// Multi-sheet workbook with dates, a formula (cached value), a blank header and a duplicate header.
const wb = XLSX.utils.book_new();
const salesSheet = XLSX.utils.aoa_to_sheet([
  header,
  ...sales.map((r) => header.map((h) => r[h as keyof typeof r])),
]);
XLSX.utils.book_append_sheet(wb, salesSheet, "Sales");
const kpi = XLSX.utils.aoa_to_sheet(
  [
    ["date", "site", "latency_ms", "loss_pct", "", "site"],
    [new Date(2026, 9, 1), "SJC", 21.5, 0.2, "note", "dup"],
    [new Date(2026, 9, 2), "SJC", 23.1, 0.3, null, "dup"],
    [new Date(2026, 9, 3), "NYC", 48.0, 0.9, null, "dup"],
  ],
  { cellDates: true },
);
XLSX.utils.book_append_sheet(wb, kpi, "KPIs");
const totals = XLSX.utils.aoa_to_sheet([
  ["region", "q1", "q2", "total"],
  ["North", 200, 130, null],
  ["East", 220, 160, null],
]);
totals.D2 = { t: "n", f: "B2+C2", v: 330 };
totals.D3 = { t: "n", f: "B3+C3", v: 380 };
XLSX.utils.book_append_sheet(wb, totals, "Totals");
out("workbook.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellDates: true }) as Buffer);
out("workbook.xls", XLSX.write(wb, { type: "buffer", bookType: "biff8" }) as Buffer);
out("workbook.ods", XLSX.write(wb, { type: "buffer", bookType: "ods" }) as Buffer);

// A related set in five formats that share keys (site code, region) for multi-source linking.
// Keys are written inconsistently on purpose (SJC vs sjc) because real exports are like that.
mkdirSync(path.join(DIR, "linked"), { recursive: true });
const SITES = [
  { site_code: "SJC", city: "San Jose", region: "Americas", tier: "Gold", circuit_mbps: 1000, base: 18 },
  { site_code: "DAL", city: "Dallas", region: "Americas", tier: "Silver", circuit_mbps: 500, base: 32 },
  { site_code: "NYC", city: "New York", region: "Americas", tier: "Gold", circuit_mbps: 1000, base: 41 },
  { site_code: "LON", city: "London", region: "EMEA", tier: "Gold", circuit_mbps: 1000, base: 74 },
  { site_code: "FRA", city: "Frankfurt", region: "EMEA", tier: "Silver", circuit_mbps: 500, base: 82 },
  { site_code: "DXB", city: "Dubai", region: "EMEA", tier: "Bronze", circuit_mbps: 200, base: 118 },
  { site_code: "SIN", city: "Singapore", region: "APAC", tier: "Silver", circuit_mbps: 500, base: 136 },
  { site_code: "SYD", city: "Sydney", region: "APAC", tier: "Bronze", circuit_mbps: 200, base: 152 },
];
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const telemetry: string[] = ["date,site,latency_ms,packet_loss_pct,throughput_mbps"];
for (let d = 1; d <= 14; d++) {
  for (const s of SITES) {
    const spike = s.site_code === "DXB" && d >= 9 && d <= 11 ? 60 : 0;
    const latency = s.base + spike + rand() * 8;
    const loss = (s.tier === "Bronze" ? 0.6 : s.tier === "Silver" ? 0.3 : 0.1) + rand() * 0.3 + spike / 100;
    const thr = Math.round(s.circuit_mbps * (0.45 + rand() * 0.35));
    telemetry.push(`${day(d)},${s.site_code},${latency.toFixed(1)},${loss.toFixed(2)},${thr}`);
  }
}
out("linked/wan-telemetry.csv", telemetry.join("\n") + "\n");

const sitesWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  sitesWb,
  XLSX.utils.json_to_sheet(SITES.map(({ base: _b, ...s }) => s)),
  "Sites",
);
out("linked/sites.xlsx", XLSX.write(sitesWb, { type: "buffer", bookType: "xlsx" }) as Buffer);

const SEVERITY = ["P1", "P2", "P3"];
const incidents = Array.from({ length: 28 }, (_, i) => {
  const s = SITES[Math.floor(rand() * SITES.length)]!;
  const dxb = i % 5 === 0 ? SITES[5]! : s;
  const sev = SEVERITY[Math.min(2, Math.floor(rand() * 3 + (dxb.tier === "Gold" ? 0.8 : 0)))]!;
  return {
    ticket: `INC-${4100 + i}`,
    site: dxb.site_code.toLowerCase(),
    severity: sev,
    opened: day(1 + Math.floor(rand() * 14)),
    minutes_to_resolve: Math.round((sev === "P1" ? 45 : sev === "P2" ? 120 : 300) * (0.6 + rand())),
  };
});
out("linked/incidents.json", JSON.stringify({ source: "itsm-export", incidents }, null, 2) + "\n");

const hubs = ["SJC", "LON", "SIN"];
out(
  "linked/wan-topology.yaml",
  toYaml({
    nodes: SITES.map((s) => ({
      id: s.site_code,
      label: `${s.city} ${hubs.includes(s.site_code) ? "hub" : "edge"}`,
      type: hubs.includes(s.site_code) ? "router" : "sd-wan",
      role: hubs.includes(s.site_code) ? "hub" : "branch",
    })),
    links: [
      ...SITES.filter((s) => !hubs.includes(s.site_code)).map((s) => ({
        source: s.region === "Americas" ? "SJC" : s.region === "EMEA" ? "LON" : "SIN",
        target: s.site_code,
        bandwidth_mbps: s.circuit_mbps,
      })),
      { source: "SJC", target: "LON", bandwidth_mbps: 10000 },
      { source: "LON", target: "SIN", bandwidth_mbps: 10000 },
      { source: "SIN", target: "SJC", bandwidth_mbps: 10000 },
    ],
  }),
);

// Coarse region outlines (lon/lat). Rings are oriented so d3.geoArea gives the small (inside) area, i.e. the
// winding d3-geo expects; the renderer also rewinds RFC 7946 rings, with a note.
const poly = (pts: Array<[number, number]>) => {
  const g = { type: "Polygon" as const, coordinates: [[...pts, pts[0]!]] };
  if (d3.geoArea(g) > 2 * Math.PI) g.coordinates[0]!.reverse();
  return g;
};
out(
  "linked/regions.geojson",
  JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Americas" },
        geometry: poly(
          [
            [-168, 66],
            [-165, 54],
            [-125, 48],
            [-117, 32],
            [-97, 16],
            [-80, 8],
            [-81, -5],
            [-72, -18],
            [-74, -52],
            [-66, -55],
            [-58, -38],
            [-40, -22],
            [-35, -6],
            [-50, 0],
            [-62, 10],
            [-80, 25],
            [-76, 38],
            [-66, 44],
            [-55, 52],
            [-64, 60],
            [-78, 63],
            [-95, 70],
            [-125, 70],
            [-150, 71],
          ].reverse() as Array<[number, number]>,
        ),
      },
      {
        type: "Feature",
        properties: { name: "EMEA" },
        geometry: poly(
          [
            [-10, 36],
            [-17, 21],
            [-17, 14],
            [-8, 4],
            [9, 4],
            [12, -5],
            [12, -17],
            [18, -34],
            [27, -34],
            [35, -24],
            [40, -15],
            [40, -2],
            [51, 11],
            [44, 12],
            [57, 24],
            [60, 25],
            [56, 38],
            [45, 42],
            [40, 48],
            [40, 60],
            [30, 70],
            [15, 70],
            [5, 62],
            [-5, 58],
            [-10, 52],
            [-10, 44],
          ].reverse() as Array<[number, number]>,
        ),
      },
      {
        type: "Feature",
        properties: { name: "APAC" },
        geometry: poly(
          [
            [68, 24],
            [73, 8],
            [80, 7],
            [88, 22],
            [94, 16],
            [98, 8],
            [104, 1],
            [109, 12],
            [108, 21],
            [121, 30],
            [122, 40],
            [130, 43],
            [141, 46],
            [142, 40],
            [134, 34],
            [130, 32],
            [122, 24],
            [120, 14],
            [125, 7],
            [120, 0],
            [131, -2],
            [141, -10],
            [146, -18],
            [153, -26],
            [151, -34],
            [145, -39],
            [137, -35],
            [129, -32],
            [116, -35],
            [114, -22],
            [130, -12],
            [118, -8],
            [106, -6],
            [100, 2],
            [96, 22],
            [92, 27],
            [80, 30],
            [72, 33],
          ].reverse() as Array<[number, number]>,
        ),
      },
    ],
  }) + "\n",
);
