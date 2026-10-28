import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Dataset } from "../data/types.js";
import type { VisualizationSpec } from "../schema/spec.js";
import { D3McpError } from "../../shared/errors.js";
import { isSafeId } from "../../shared/escape.js";
import { log } from "../../shared/logger.js";

export type ArtifactFormat = "html" | "svg" | "png" | "pdf" | "json" | "csv";

export interface ArtifactFile {
  path: string;
  bytes: number;
  sha256: string;
  uri: string;
}

export interface ArtifactRecord {
  id: string;
  sessionId: string;
  kind: "visualization" | "dashboard";
  title: string;
  visualizationType: string;
  specIds: string[];
  datasetIds: string[];
  createdAt: string;
  dir: string;
  width: number;
  height: number;
  markCount: number;
  markSelector: string;
  files: Partial<Record<ArtifactFormat, ArtifactFile>>;
  exportErrors: Partial<Record<ArtifactFormat, string>>;
  validation: Record<string, unknown>;
  warnings: string[];
  parentArtifactId?: string;
}

export class ArtifactStore {
  private records = new Map<string, ArtifactRecord>();
  private datasets = new Map<string, Dataset>();
  private specs = new Map<string, { spec: VisualizationSpec; sessionId: string }>();

  constructor(
    readonly root: string,
    private readonly ttlHours: number,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.cleanup();
  }

  private ensureInside(p: string): string {
    const resolved = path.resolve(p);
    const root = path.resolve(this.root) + path.sep;
    if (!resolved.startsWith(root)) throw new D3McpError("SECURITY_VIOLATION", "Path escapes the artifact directory");
    return resolved;
  }

  static checkId(id: string, what: string): void {
    if (!isSafeId(id)) throw new D3McpError("INVALID_INPUT", `Invalid ${what} "${id.slice(0, 80)}"`, "Use 1–64 characters: letters, digits, '_' or '-'.");
  }

  sessionDir(sessionId: string): string {
    ArtifactStore.checkId(sessionId, "session_id");
    return this.ensureInside(path.join(this.root, sessionId));
  }

  async saveDataset(ds: Dataset, sessionId: string): Promise<void> {
    ArtifactStore.checkId(ds.id, "dataset id");
    this.datasets.set(ds.id, ds);
    if (this.datasets.size > 500) this.datasets.delete(this.datasets.keys().next().value as string);
    const dir = path.join(this.sessionDir(sessionId), "datasets");
    await mkdir(dir, { recursive: true });
    await writeFile(this.ensureInside(path.join(dir, `${ds.id}.json`)), JSON.stringify(ds));
  }

  async getDataset(id: string): Promise<Dataset> {
    ArtifactStore.checkId(id, "dataset_id");
    const mem = this.datasets.get(id);
    if (mem) return mem;
    for (const s of await this.sessions()) {
      const p = path.join(this.root, s, "datasets", `${id}.json`);
      if (existsSync(p)) {
        const ds = JSON.parse(await readFile(this.ensureInside(p), "utf8")) as Dataset;
        this.datasets.set(id, ds);
        return ds;
      }
    }
    throw new D3McpError("ARTIFACT_NOT_FOUND", `Dataset "${id}" not found`, "Datasets expire with the artifact TTL; resend the data.");
  }

  async saveSpec(spec: VisualizationSpec, sessionId: string): Promise<string> {
    this.specs.set(spec.id, { spec, sessionId });
    const dir = path.join(this.sessionDir(sessionId), "specs");
    await mkdir(dir, { recursive: true });
    const p = this.ensureInside(path.join(dir, `${spec.id}.json`));
    await writeFile(p, JSON.stringify(spec, null, 2));
    return p;
  }

  async getSpec(id: string): Promise<VisualizationSpec> {
    ArtifactStore.checkId(id, "spec id");
    const mem = this.specs.get(id);
    if (mem) return mem.spec;
    for (const s of await this.sessions()) {
      const p = path.join(this.root, s, "specs", `${id}.json`);
      if (existsSync(p)) return JSON.parse(await readFile(this.ensureInside(p), "utf8")) as VisualizationSpec;
    }
    throw new D3McpError("ARTIFACT_NOT_FOUND", `Specification "${id}" not found`);
  }

  async createArtifactDir(sessionId: string, artifactId: string): Promise<string> {
    ArtifactStore.checkId(artifactId, "artifact id");
    const dir = this.ensureInside(path.join(this.sessionDir(sessionId), artifactId));
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async writeArtifactFile(dir: string, name: string, content: string | Buffer): Promise<ArtifactFile> {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name)) throw new D3McpError("SECURITY_VIOLATION", "Invalid artifact file name");
    const p = this.ensureInside(path.join(dir, name));
    await writeFile(p, content);
    return this.describeFile(p);
  }

  async describeFile(p: string): Promise<ArtifactFile> {
    const abs = this.ensureInside(p);
    const buf = await readFile(abs);
    return { path: abs, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), uri: `file://${abs.split(path.sep).map(encodeURIComponent).join("/")}` };
  }

  async saveRecord(rec: ArtifactRecord): Promise<void> {
    this.records.set(rec.id, rec);
    await writeFile(this.ensureInside(path.join(rec.dir, "metadata.json")), JSON.stringify(rec, null, 2));
  }

  async get(id: string): Promise<ArtifactRecord> {
    ArtifactStore.checkId(id, "artifact_id");
    const mem = this.records.get(id);
    if (mem) return mem;
    for (const s of await this.sessions()) {
      const p = path.join(this.root, s, id, "metadata.json");
      if (existsSync(p)) {
        const rec = JSON.parse(await readFile(this.ensureInside(p), "utf8")) as ArtifactRecord;
        this.records.set(id, rec);
        return rec;
      }
    }
    throw new D3McpError("ARTIFACT_NOT_FOUND", `Artifact "${id}" not found`, "Use an artifact_id returned by d3_visualize/d3_render, or list artifacts with d3_get_artifact {list:true}.");
  }

  async list(sessionId?: string): Promise<ArtifactRecord[]> {
    const out: ArtifactRecord[] = [];
    const sessions = sessionId ? [sessionId] : await this.sessions();
    for (const s of sessions) {
      const dir = this.sessionDir(s);
      if (!existsSync(dir)) continue;
      for (const e of await readdir(dir)) {
        const meta = path.join(dir, e, "metadata.json");
        if (existsSync(meta)) {
          try {
            out.push(JSON.parse(await readFile(meta, "utf8")) as ArtifactRecord);
          } catch {
            /* skip corrupt */
          }
        }
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async sessions(): Promise<string[]> {
    if (!existsSync(this.root)) return [];
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && isSafeId(e.name)).map((e) => e.name);
  }

  /** Delete artifacts and datasets older than the TTL. */
  async cleanup(now = Date.now()): Promise<number> {
    const cutoff = now - this.ttlHours * 3_600_000;
    let removed = 0;
    for (const s of await this.sessions()) {
      const dir = path.join(this.root, s);
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const p = path.join(dir, e.name);
        if (e.name === "datasets" || e.name === "specs") {
          for (const f of await readdir(p)) {
            const fp = path.join(p, f);
            if ((await stat(fp)).mtimeMs < cutoff) {
              await rm(fp, { force: true });
              removed++;
            }
          }
          continue;
        }
        if ((await stat(p)).mtimeMs < cutoff) {
          await rm(this.ensureInside(p), { recursive: true, force: true });
          this.records.delete(e.name);
          removed++;
        }
      }
    }
    if (removed) log.info("artifact cleanup", { removed });
    return removed;
  }
}
